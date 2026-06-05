/**
 * BaseAgent — 所有协作 Agent 的公共接口。
 *
 * 子类只需重写 `systemPrompt` getter 来定义角色人设；
 * 公共能力（绑定 LLM、持有专属 RAGRetriever、tool_calls 循环、结构化收尾）都在这里实现。
 */

import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { Runnable } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import {
  AGENT_NAMES,
  ARCHITECT,
  ROLE_DESCRIPTIONS,
  isAgentName,
} from "../config/constants.js";
import { getSettings } from "../config/settings.js";
import { type RAGRetriever, getRetriever } from "../database/index.js";
import { getLogger } from "../utils/logger.js";
import { cleanBadChars} from "../utils/utils.js";
import { streamStructuredContent } from "./streamStructured.js";
// 全局工具清单（本地工具 + bootstrap 阶段异步登记的 MCP 工具）。
// allTools 是共享数组引用：bootstrap 里追加的 MCP 工具，这里 bindTools 时也能看到。
import { allTools } from "../tools/toolRegister.js";

const _MAX_TOOL_ITERATIONS = 5;
const logger = getLogger("agents.base");


/**
 * LLM 单轮回复的强约束 schema。
 *
 * 用 `withStructuredOutput(ModelOutputSchema)` 让模型按这个 schema 生成结构化输出，
 * 省掉旧版的 `[NEXT_AGENT: …]` / `[DONE]` 自然语言标记 + 正则解析方案。
 */
export const ModelOutputSchema = z.object({
  content: z
    .string()
    .describe("给用户与其他 agent 看的正文。本字段才是真正展示出去的回复。"),
  next_agent: z
    .string()
    .describe(
      "下一个发言 agent 的名字，必须是 architect / backend / frontend / tester / pm 之一。" +
        "非架构师角色发言结束后通常应填 'architect'；架构师宣布完成时这里也填 'architect'（占位即可）。",
    ),
  done: z
    .string()
    .describe(
      "本轮讨论是否完成。只允许两个字符串值：" +
        "'true' —— 架构师认为整个用户需求已被处理完毕，本轮可以结束；" +
        "'false' —— 还需要继续讨论。非架构师角色一律填 'false'。",
    ),
});
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

/**
 * 把结构化输出里的 done 收敛成 bool。
 * schema 声明 done 是字符串('true'/'false')，但部分 OpenAI 兼容后端会无视 schema、
 * 直接返回 JSON 布尔 true/false——这时 done 是 boolean，旧代码 output.done.trim() 会抛
 * "trim is not a function"。所以这里同时兼容 boolean 与字符串两种形态。
 */
export function coerceDone(done: unknown): boolean {
  if (typeof done === "boolean") {
    return done;
  }
  const rawStr = String(done);
  const doneStr = rawStr.trim().toLowerCase();
  return (
    doneStr === "true" ||
    doneStr === "yes" ||
    doneStr === "1" ||
    doneStr === "y" ||
    doneStr === "done" ||
    doneStr === "完成"
  );
}


/**
 * 把会话主人的个人记忆拼成放在 systemPrompt 最前面的一段。
 * 空 / 纯空白记忆返回空串（不加任何噪声）；否则带一个简短中文抬头，
 * 让 LLM 知道这是用户长期背景、优先级最高。结尾留两个换行与角色提示词隔开。
 */
export function memorySection(userMemory: string): string {
  const trimmed = userMemory.trim();
  if (!trimmed) {
    return "";
  }
  return (
    "=== 用户长期记忆（最高优先级背景信息，贯穿所有回复）===\n" +
    `${trimmed}\n\n`
  );
}

/**
 * 会议结束「一次性整理」的结构化输出 schema：一次 LLM 调用同时产出
 * 会议纪要(minutes) + 每个角色的工作段(按 agent 名平铺)。
 *
 * 刻意保持单层(和 ModelOutputSchema 一样、不嵌套)，因为很多 OpenAI 兼容后端
 * 对嵌套对象的结构化输出不稳。字段由 AGENT_NAMES 动态拼出，避免和常量脱节。
 */
const _summaryShape: Record<string, z.ZodString> = {
  minutes: z
    .string()
    .describe(
      "会议纪要正文：用户提出了什么需求或问题、讨论中达成的关键结论与决策、尚未解决的待办事项。" +
        "markdown 正文，不要加一级 / 二级标题（标题由外层组装）。",
    ),
};
for (const _name of AGENT_NAMES) {
  const _roleDesc = ROLE_DESCRIPTIONS[_name] ?? _name;
  _summaryShape[_name] = z
    .string()
    .describe(
      `${_roleDesc} 在本次需求中需要完成的具体工作 / 行动项。` +
        "用 markdown 列表或短段落；与该角色职责无关、没有要做的事，就只填两个字：无。不要加标题。",
    );
}
export const MeetingSummarySchema = z.object(_summaryShape);
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;


/**
 * 一次 Agent.invoke() 的产物，同时也是追加进 `AgentState.messages` 的历史条目
 */
/** 一次工具调用的完整记录：工具名 + 入参 + 返回结果。用于前端「每个调用一个按钮、点开看结果」。 */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export interface AgentResponse {
  agent_name: string;
  role: string;
  message: string;
  next_agent: string | null;
  done: boolean;
  used_rag: boolean;
  // 本轮用过的工具名(去重、", "连接);没用工具则为空串/缺省。用于前端常驻 UsingTools 标签。
  tool?: string;
  // 本轮每一次工具调用的明细(name/args/result)，按调用顺序排列。落库进 messages.tool_calls(jsonb)。
  tool_calls?: ToolCallRecord[];
  // 这条消息在 DB 里的写入时间(只读,仅 getMessages 回填给前端展示发送时间);
  // 不参与 LLM,也不由 appendMessages 写入(写入时间由 DB 列 DEFAULT now() 自动生成)。
  created_at?: string;
}

export abstract class BaseAgent {
  /** 刻意用 PascalCase 命名 `RAGRetriever`，不要"修正"为 camelCase。 */
  readonly RAGRetriever: RAGRetriever;
  protected _model: ChatOpenAI;
  /** 构造阶段就把 tools 绑好的模型，Phase 1 工具循环直接用，避免每轮 invoke 重复 bindTools。 */
  protected _modelWithTools: Runnable;

  /** 构造一个 Agent：拿到本 agent 的 RAGRetriever，按 settings 实例化 ChatOpenAI，bindTools(allTools)，关掉思考模式。 */
  protected constructor(
      readonly name: string,
      readonly role: string
  ) {
    const settings = getSettings();
    // 和 rag_search 工具共用同一个 RAGRetriever 实例（按 agent 名缓存），
    // 这样工具里的检索调用次数能被这里的 callCount / used_rag 统计到
    this.RAGRetriever = getRetriever(name);
    this._model = new ChatOpenAI({
      apiKey: settings.apiKey,
      configuration: { baseURL: settings.baseUrl },
      model: settings.modelName,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      // 关闭后端的 thinking 模式（OpenAI 兼容协议的扩展字段）
      modelKwargs: { thinking: { type: "disabled" } },
    });

    // 初始化阶段一次性绑定全部工具（不在每轮 invoke 里反复 bindTools）
    this._modelWithTools = this._model.bindTools(allTools);
  }

  // ---------- 提示词 ----------

  /** 子类实现：返回该角色的 system prompt（人设 + 职责）。getter 形式，按属性访问。 */
  // 方法前面写 get，表示这是一个 getter，可以直接通过 this.systemPrompt 访问，而不是 this.systemPrompt()
  abstract get systemPrompt(): string;

  /** 拼装本轮发言要喂给 LLM 的 user prompt：用户需求 + 历史 + 角色身份 + tools 使用守则。 */
  protected _userPrompt(requirement: string, history: string): string {
    return (
      `用户输入是：${requirement}\n` +
      `已有讨论历史是：${history || "(尚无讨论)"}\n` +
      "以下元规则优先级最高，高于你的角色默认行为：如果用户输入里有明确的字面指令必须严格遵守，不要无视、不要扩展、不要加戏；" +
      "如果用户输入只是闲聊或简单指令而不是真正的项目或技术需求，就照字面意思回应一句即可，不要拆解、不要写用户故事、不要写接口设计；" +
      "仅当用户输入确实是一个项目或技术需求时，才以下面的角色身份做拆解、设计、用例规划等动作。\n" +
      `你的任务是以 ${ROLE_DESCRIPTIONS[this.name] ?? this.name} 的身份回应上面的输入。` +
      "关于 工具的使用：tools的成本和延迟都不低，默认不要调用。只有当你确实需要外部知识——" +
      "即必须查阅过往代码、文档、历史方案或专业资料才能给出一个有信息量的答案时，才调用它。" +
      "判断标准很简单：先想清楚『不查工具我能不能答好这一句』，如果能，就直接答，绝不调用。" +
      "凡是闲聊、打招呼、复述、确认、纯字面的简单指令、或答案你本就清楚的问题，一律直接回答，不要调用工具。" +
      "用户明确说不用 tools 时同样直接回答。" +
      "最后按系统指示选择下一个 agent。"
    );
  }

  /** 生成追加到 systemPrompt 末尾的路由约束段：教 LLM 如何填 ModelOutput 三字段 + 反循环硬规则。 */
  protected _routingPrompt(): string {
    // 拿到除自己外所有 agents 名单
    const peersList: string[] = [];
    for (const a of AGENT_NAMES) {
      if (a !== this.name) {
        peersList.push(a);
      }
    }
    const peers = peersList.join(", ");
    return (
      "\n\n=== 输出字段填写指南（你的最终回复会被强制约束为 JSON）===\n" +
      "你的回复将被序列化为三字段对象 ModelOutput { content, next_agent, done }。\n" +
      "  • content    : 给用户和其他 agent 看的正文，写在这里就行，不要再额外加 [NEXT_AGENT] / [DONE] 标记。\n" +
      `  • next_agent : 下一个发言 agent 的名字。可选项: ${peers}, ${this.name}。\n` +
      "                 非架构师角色发言结束后通常填 'architect'；\n" +
      "                 架构师宣布完成时也填 'architect'（占位用）。\n" +
      "  • done       : 字符串 'true' 或 'false'。\n" +
      "                 仅架构师在整个用户需求都处理完时填 'true'，其它任何情况一律 'false'。\n\n" +
      "=== 反循环硬规则（违反会让讨论卡到 max_iterations）===\n" +
      "1. 严禁重复别人或自己之前说过的话：先扫一眼上面的「已有讨论历史」，\n" +
      "   如果你打算说的内容已经有人说过类似的，要么补充新角度，要么不说。\n" +
      "2. 如果用户输入只是闲聊/打招呼/简单 Q&A，架构师应该自己一句话回完就把 done 设为 'true'，\n" +
      "   不要无意义地路由到 pm / backend / frontend / tester。\n" +
      "3. 如果你（非架构师）发现自己只能输出寒暄性回复、没有专业信息可补充，\n" +
      "   仍然把 next_agent 填 'architect'，由架构师决定是否 done='true'。\n" +
      "4. **反喧宾夺主**：如果用户输入里点名了具体角色（如「pm 查 X」「让 backend 做 Y」），\n" +
      "   架构师【绝不能】自己先调用 rag_search 等工具去做那件事，\n" +
      "   也不能自己代答；唯一动作是简短引导一句 + next_agent 填被点名的角色名。"
    );
  }

  // ---------- 核心处理 ----------

  /**
   * 运行一次 Agent 推理，分两个阶段调 LLM。
   *
   * Phase 1 —— 工具循环（只 bindTools，不约束输出格式）
   *   LLM 自主决定调不调 RAG；调了就执行、把结果包成 ToolMessage 接回；
   *   直到 LLM 不再要工具，或循环达 _MAX_TOOL_ITERATIONS 上限。
   *
   * Phase 2 —— 结构化收尾（只 withStructuredOutput，不再带工具）
   *   在 Allmessages 末尾追加一条 HumanMessage 明确要求按 ModelOutput 汇总。
   */
  async invoke(
    requirement: string,
    conversationHistory: string,
    opts?: {
      // 会话主人的个人记忆，拼到 systemPrompt 最前面（空串则不加）。
      userMemory?: string;
      onDelta?: (text: string) => void;
      onToolUse?: (toolName: string) => void;
      // 每次工具执行完成后调一次，带上该次调用的 name/args/result（前端据此加按钮 + 展开结果）。
      onToolResult?: (rec: ToolCallRecord) => void;
      // risk>low 的工具执行前调一次，返回用户是否同意。给了才启用 HITL 审批；
      // 没给（如 CLI 路径）则不拦截、直接执行。
      onToolApproval?: (info: {
        toolName: string;
        risk: string;
        args: Record<string, unknown>;
      }) => Promise<boolean>;
    },
  ): Promise<AgentResponse> {
    // 1) 清乱码：去掉 stdin 来的孤立 surrogate
    const requirement_cleaned = cleanBadChars(requirement);
    const history_cleaned = cleanBadChars(conversationHistory);

    // 2) 准备 prompts（工具已在构造阶段绑好，这里只清零本轮 RAG 调用计数）
    this.RAGRetriever.restart();

    const userPrompt = cleanBadChars(this._userPrompt(requirement_cleaned, history_cleaned));
    // systemPrompt 由三段拼成（顺序固定）：用户记忆 + 角色提示词 + 路由提示词。
    const memoryPrompt = memorySection(opts?.userMemory ?? "");
    const systemPrompt = cleanBadChars(memoryPrompt + this.systemPrompt + this._routingPrompt());

    const Allmessages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt), // 所有的历史消息
    ];

    // 本轮每次工具调用的明细(name/args/result)，按调用顺序收集，最后挂到 response.tool_calls 落库。
    const toolCallRecords: ToolCallRecord[] = [];

    // ===== Phase 1：工具循环 =====
    // _modelWithTools 在构造阶段就已 bindTools，这里直接复用
    try {
      // exhausted 是使用工具次数是否达到上限的标志；如果达到上限就强制进入 Phase 2，避免讨论卡死在工具调用上
      let exhausted = true;
      for (let i = 0; i < _MAX_TOOL_ITERATIONS; i++) {
        const aiMsg = (await this._modelWithTools.invoke(Allmessages)) as AIMessage;
        Allmessages.push(aiMsg);

        // LLM 不再要工具，结束循环进收尾
        const toolCalls: ToolCall[] = aiMsg.tool_calls ?? [];
        if (toolCalls.length === 0) {
          // 工具使用没有达到上限，但是没有工具就退出循环了
          exhausted = false;
          break;
        }

        for (const tc of toolCalls) {
          const toolName = tc.name ?? "";
          const toolArgs = tc.args ?? {};
          const toolId = tc.id ?? "";
          logger.info(
            `[${this.name}] → 调用工具 ${toolName} args=${JSON.stringify(toolArgs)}`,
          );
          // 按名字从工具列表里找到要执行的工具；找不到就回一个占位提示，不让循环崩
          let toolToRun = undefined;
          for (const t of allTools) {
            if (t.name === toolName) {
              toolToRun = t;
              break;
            }
          }
          let toolResult: string;
          if (toolToRun) {
            // 工具的 risk 等级（自定义元数据，见各 *Tool.ts）；缺省视为 low。
            // metadata 在具体工具实例上，但 StructuredToolInterface 没暴露它，按需窄化取一下。
            const toolMeta = (toolToRun as { metadata?: Record<string, unknown> }).metadata;
            const risk = (toolMeta?.risk as string | undefined) ?? "low";
            // HITL 审批：risk 高于 low 且上层提供了 onToolApproval 时，执行前先等用户拍板。
            let approved = true;
            if (risk !== "low" && opts?.onToolApproval) {
              approved = await opts.onToolApproval({
                toolName,
                risk,
                args: toolArgs as Record<string, unknown>,
              });
            }
            if (!approved) {
              // 用户拒绝：跳过执行。仍要给这次 tool_call 一个结果（否则 OpenAI 协议
              // 会因 tool_call_id 没有对应 ToolMessage 而报错），用一句占位说明代替。
              toolResult = "(用户拒绝使用该工具)";
            } else {
              // 服务端路径:工具执行前通知前端显示 "UsingTools: <工具名>" 标签
              opts?.onToolUse?.(toolName);
              // 通过 config 把自己的 agent 名传给工具（rag_search 据此查对应私有表；web_search 忽略）
              const out = await toolToRun.invoke(toolArgs, {
                configurable: { agentName: this.name },
              });
              // 工具 invoke 可能返回 string 或 ToolMessage；统一收敛成字符串
              toolResult = typeof out === "string" ? out : JSON.stringify(out);
            }
          } else {
            toolResult = `(未知工具: ${toolName})`;
          }
          // 记下这次调用的明细(name/args/result)：收集起来落库，并实时回调给前端加按钮
          const record: ToolCallRecord = {
            name: toolName,
            args: toolArgs as Record<string, unknown>,
            result: toolResult,
          };
          toolCallRecords.push(record);
          opts?.onToolResult?.(record);
          Allmessages.push(
            new ToolMessage({ content: toolResult, tool_call_id: toolId }),
          );
        }
      }
      if (exhausted) {
        logger.warning(
          `[${this.name}] 工具调用次数已达上限 (${_MAX_TOOL_ITERATIONS})，强制进入结构化收尾阶段`,
        );
      }
    } catch (exc) {
      logger.error(`[${this.name}] Phase 1 工具循环失败: ${String(exc)}`);
      return this._buildAgentResponse({
        content: `(LLM 调用失败: ${String(exc)})`,
        next_agent: ARCHITECT,
        done: "false",
      });
    }

    // ===== Phase 2：结构化收尾 =====
    const structurePrompt =
      "以上是你（和工具）已经产出的全部上下文。" +
      "请基于以上信息，按 ModelOutput 三字段输出最终结果：\n" +
      "  • content    : 给团队看的正文（不要重复罗列上面已说过的话，给出最终结论 / 建议 / 行动项即可）\n" +
      "  • next_agent : 下一个发言 agent（architect / backend / frontend / tester / pm 之一）\n" +
      "  • done       : 'true' 或 'false'";
    Allmessages.push(new HumanMessage(structurePrompt));

    // 不带工具，强制按 ModelOutput schema 输出
    const structuredModel = this._model.withStructuredOutput(ModelOutputSchema, {
      name: "ModelOutput",
    });

    let finalOutput: ModelOutput;
    try {
      if (opts?.onDelta) {
        // 服务端路径:流式收尾,逐段吐 content 增量(真·token 打字机)
        const partialStream = await structuredModel.stream(Allmessages);
        const lastPartial = await streamStructuredContent<ModelOutput>(
          partialStream as AsyncIterable<Partial<ModelOutput>>,
          opts.onDelta,
        );
        finalOutput = lastPartial as ModelOutput;
      } else {
        // CLI 路径:一次拿完整结果,行为不变
        finalOutput = await structuredModel.invoke(Allmessages);
      }
    } catch (exc) {
      logger.error(`[${this.name}] Phase 2 结构化收尾失败: ${String(exc)}`);
      finalOutput = {
        content: `(结构化输出失败: ${String(exc)})`,
        next_agent: ARCHITECT,
        done: "false",
      };
    }

    const response = this._buildAgentResponse(finalOutput);
    if (toolCallRecords.length > 0) {
      response.tool_calls = toolCallRecords;
    }
    return response;
  }

  // ---------- 辅助方法 ----------

  /** 把 LLM 的结构化输出 coerce 成 AgentResponse：done 字符串→bool，非法 next_agent 兜底回架构师。 */
  private _buildAgentResponse(output: ModelOutput): AgentResponse {
    // done 可能是字符串('true'/'完成'…)，也可能被后端当 JSON 布尔返回，coerceDone 两者都兼容
    const isDone = coerceDone(output.done);

    // 非法 next_agent 兜底回架构师，保证图不卡死
    let nextAgentName = output.next_agent.trim().toLowerCase();
    if (!isAgentName(nextAgentName)) {
      logger.warning(
        `[${this.name}] next_agent='${nextAgentName}' 不在已知列表，兜底回 ${ARCHITECT}`,
      );
      nextAgentName = ARCHITECT;
    }

    let result: AgentResponse;
    result = {
      agent_name: this.name,
      role: this.role,
      message: output.content.trim(),
      next_agent: nextAgentName,
      done: isDone,
      used_rag: this.RAGRetriever.callCount > 0,
    };
    return result;
  }

  // ---------- 会议结束：一次性整理 ----------

  /**
   * 会议结束整理：单次 LLM 调用同时产出会议纪要 + 各角色工作段。
   *
   * 用 `withStructuredOutput(MeetingSummarySchema)` 强制返回平铺的
   * `{ minutes, <每个 agent 名>: 工作段 }`；取代旧版「架构师 1 次纪要 + 5 个角色各 1 次」共 6 次调用。
   * 失败时返回占位结构（minutes 写错误信息、各角色填「无」）而非抛出，让外层照常组装出一份文件。
   */
  async summarizeAll(transcript: string): Promise<MeetingSummary> {
    const transcript_cleaned = cleanBadChars(transcript);
    const prompt =
      "下面是一次多角色团队会议的完整记录。请你通读后，一次性整理出下列各字段：\n" +
      "  • minutes：一份简洁清晰的会议纪要（用户需求 / 关键结论与决策 / 待办事项）。\n" +
      "  • 其余每个字段：分别站在对应角色的立场，总结该角色在本次需求中要做的具体工作 / 行动项；\n" +
      "    与该角色无关、没有要做的事就只填两个字：无。\n" +
      "所有字段都用 markdown 正文 / 列表，不要加标题（标题由外层另加）。\n\n" +
      `=== 会议记录 ===\n${transcript_cleaned}`;
    const structuredModel = this._model.withStructuredOutput(MeetingSummarySchema, {
      name: "MeetingSummary",
    });
    try {
      const result = await structuredModel.invoke([
        new SystemMessage(cleanBadChars(this.systemPrompt)),
        new HumanMessage(cleanBadChars(prompt)),
      ]);
      return result;
    } catch (exc) {
      logger.error(`[${this.name}] summarizeAll 失败: ${String(exc)}`);
      const fallback: Record<string, string> = {
        minutes: `(会议纪要生成失败: ${String(exc)})`,
      };
      for (const name of AGENT_NAMES) {
        fallback[name] = "无";
      }
      return fallback;
    }
  }
}
