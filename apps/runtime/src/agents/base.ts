/**
 * BaseAgent — 所有协作 Agent 的公共接口。
 *
 * 子类只需重写 `systemPrompt` getter 来定义角色人设；
 * 公共能力（绑定 LLM、持有专属 RAGRetriever、tool_calls 循环、结构化收尾）都在这里实现。
 */

import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
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
import { runToolLoop } from "./toolLoop.js";
// 全局工具清单（本地工具 + bootstrap 阶段异步登记的 MCP 工具）。
// allTools 是共享数组引用：bootstrap 里追加的 MCP 工具，这里 bindTools 时也能看到。
import { allTools } from "../tools/toolRegister.js";

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
  protected _userPrompt(requirement: string, history: string, intent?: string): string {
    // intent_node 的意图初判：只当一句弱提示，明确告知模型「仅供参考、别被它带偏」，
    // 避免分类误判把正常需求挡掉——硬决策仍由角色自身按元规则做。
    const trimmedIntent = (intent ?? "").trim();
    let intentHint = "";
    if (trimmedIntent) {
      intentHint = `（系统对本次输入的意图初判为「${trimmedIntent}」，仅供参考，若与字面不符以字面为准。）\n`;
    }
    return (
      `用户输入是：${requirement}\n` +
      intentHint +
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
   *   直到 LLM 不再要工具，或循环达 MAX_TOOL_ITERATIONS 上限。
   *
   * Phase 2 —— 结构化收尾（只 withStructuredOutput，不再带工具）
   *   在 Allmessages 末尾追加一条 HumanMessage 明确要求按 ModelOutput 汇总。
   */
  async invoke(
    requirement: string,
    conversationHistory: string,
    // 走 CLI 就不会有 opts 参数
    opts?: {
      // 会话主人的个人记忆，拼到 systemPrompt 最前面（空串则不加）。
      userMemory?: string;
      // intent_node 识别出的本轮意图标签，拼进 _userPrompt 当一句参考提示（空串则不加）。
      intent?: string;
      // rewrite_node 产出的检索扩展词，经 config 透传给 rag_search 拼到 query 后面提升召回（空串则不加）。
      expansionTerms?: string;
      // 当 phase 2 结构化收尾时，content 又多出一小段字，就调一次这个回调，把「新增的那截」传出去
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

    const userPrompt = cleanBadChars(
      this._userPrompt(requirement_cleaned, history_cleaned, opts?.intent),
    );
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
    // _modelWithTools 在构造阶段就已 bindTools；工具循环抽到 toolLoop.ts，和右侧回答助手共用。
    // directAnswer：模型本轮不调工具、直接拟好的回答（如「你有什么工具」这种问题）。
    // 这段文本只活在 Phase 1 的 assistant 消息里、用户看不到，必须捞出来喂进 Phase 2 当 content 种子，
    // 否则会被「不要复读上文」的收尾提示词吞掉（前端只显示 Phase 2 的 content）。
    let directAnswer = "";
    try {
      directAnswer = await runToolLoop(this._modelWithTools, Allmessages, toolCallRecords, {
        callerName: this.name,
        agentName: this.name,
        expansionTerms: opts?.expansionTerms,
        onToolUse: opts?.onToolUse,
        onToolResult: opts?.onToolResult,
        onToolApproval: opts?.onToolApproval,
      });
    } catch (exc) {
      logger.error(`[${this.name}] Phase 1 工具循环失败: ${String(exc)}`);
      return this._buildAgentResponse({
        content: `(LLM 调用失败: ${String(exc)})`,
        next_agent: ARCHITECT,
        done: "false",
      });
    }

    // ===== Phase 2：结构化收尾 =====
    // content 必须「自包含」：上面那些过程性文本（Phase 1 的 assistant 回答、工具结果）用户都看不到，
    // 只有这里的 content 会显示。所以不能只写「见上文」之类指代——本轮要回答用户的内容要完整落在 content 里。
    let structurePrompt =
      "以上是你（和工具）已经产出的全部上下文。" +
      "请基于以上信息，按 ModelOutput 三字段输出最终结果：\n" +
      "  • content    : 给团队看的正文，必须能被独立阅读——上面那些过程内容用户看不到，" +
      "所以不要只写「见上文 / 如上所述」之类指代，要把本轮的最终结论 / 建议 / 行动项 / 清单本身完整写进来；" +
      "（多轮历史里早已说过的旧话可以不复读，但「本轮要回答用户的内容」必须完整出现在这里）\n" +
      "  • next_agent : 下一个发言 agent（architect / backend / frontend / tester / pm 之一）\n" +
      "  • done       : 'true' 或 'false'";
    // 若 Phase 1 已直接拟好回答，把它作为 content 主体喂回去，避免模型凭记忆缩写成一句指代。
    const directAnswer_trimmed = directAnswer.trim();
    if (directAnswer_trimmed) {
      structurePrompt +=
        "\n\n你本轮已直接拟好下面这段回答，请把它作为 content 的主体" +
        "（可润色 / 补充，但不要丢内容、不要缩写成一句指代）：\n" +
        "----\n" +
        directAnswer_trimmed +
        "\n----";
    }
    Allmessages.push(new HumanMessage(structurePrompt));

    // 不带工具，强制按 ModelOutput schema 输出
    const structuredModel = this._model.withStructuredOutput(ModelOutputSchema, {
      name: "ModelOutput",
    });

    let finalOutput: ModelOutput;
    try {
      // opts?.onDelta代表是否启用流式收尾
      if (opts?.onDelta) {
        // .stream 流式调用并返回
        // structuredModel.stream() 会一帧帧吐出不完整的 { content?, next_agent?, done? }（content 往往越来越长）
        const partialStream = await structuredModel.stream(Allmessages);
        
        // 逐段吐 content 增量(真·token 打字机)
        // 若当前帧的 content 比已发出的更长 → 取出 增量 increment → 调 onDelta(increment)
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
