/**
 * AssistantAgent —— 右侧「回答助手」单节点工作流的角色。
 *
 * 它继承 BaseAgent 只为复用构造期能力（ChatOpenAI 实例、bindTools(allTools)、关思考模式），
 * 但【不走】BaseAgent.invoke 那套两阶段协作流程——协作版 Phase 2 会强制结构化输出
 * { content, next_agent, done } 并交给条件边在 5 个角色间路由，而助手不路由给任何人、答完即结束。
 *
 * 所以这里另开一个 `answer()`：Phase 1 复用同一套工具循环（runToolLoop），Phase 2 改成
 * 「纯自然语言流式收尾」，不结构化、不填 next_agent。产出的 AgentResponse 里 next_agent=null、
 * done=true（单节点工作流一答即完），由 assistant_node 直接 → END。
 *
 * 与左侧团队的唯一共享：AgentState（读历史 / 记忆，写自己的一条 message）+ 同一批工具。
 * iteration 等左侧专属字段它一概不碰，两条工作流天然隔离。
 */

import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";

import { ASSISTANT } from "../config/constants.js";
import { getLogger } from "../utils/logger.js";
import { cleanBadChars } from "../utils/utils.js";
import {
  type AgentResponse,
  BaseAgent,
  type ToolCallRecord,
  memorySection,
} from "./base.js";
import { runToolLoop } from "./toolLoop.js";

const logger = getLogger("agents.assistant");

/** answer() 的回调 + 透传项；与 BaseAgent.invoke 的 opts 形态对齐，方便 assistant_node 复用同一套流式 plumbing。 */
interface AnswerOptions {
  userMemory?: string;
  expansionTerms?: string;
  onDelta?: (text: string) => void;
  onToolUse?: (toolName: string) => void;
  onToolResult?: (rec: ToolCallRecord) => void;
  onToolApproval?: (info: {
    toolName: string;
    risk: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;
}

export class AssistantAgent extends BaseAgent {
  /** 注册名 assistant（刻意不在 AGENT_NAMES 里）+ 中文角色标签。 */
  constructor() {
    super(ASSISTANT, "回答助手");
  }

  /** 回答助手人设：只做日常对话与即时问答，不拆需求、不路由团队。 */
  get systemPrompt(): string {
    return (
      "你是「回答助手」，MeetMind 多 agent 系统里负责日常对话与即时问答的角色。" +
      "当用户只是闲聊、打招呼，或提一个一问一答就能解决的知识 / 技术问题时，由你直接回答，不惊动架构师那支开发团队。\n" +
      "要求：\n" +
      "1. 结合上面的对话历史与用户长期记忆，自然、简洁地回应——闲聊就轻松回，问答就给清晰准确的答案。\n" +
      "2. 你没有私有知识库（rag_search 对你无效）；确需外部最新信息时用联网搜索 / 网页抓取类工具，否则凭你已有知识与对话上下文回答即可。\n" +
      "3. 工具有成本，默认不调用：先想清楚「不查工具我能不能答好这一句」，能就直接答。\n" +
      "4. 不要拆解需求、不要写用户故事 / 接口设计 / 测试用例——那是开发团队的事，你只负责对话和答疑。"
    );
  }

  /** 拼装喂给助手的 user prompt：用户输入 + 历史，要求结合上下文自然作答。 */
  private _assistantUserPrompt(requirement: string, history: string): string {
    return (
      `用户输入是：${requirement}\n` +
      `已有对话历史是：${history || "(尚无对话)"}\n` +
      "请结合上面的历史与用户记忆，直接用自然语言回答用户这一句。"
    );
  }

  /** 把回答文本收敛成 AgentResponse：next_agent=null（不路由）、done=true（单节点一答即完）。 */
  private _buildAssistantResponse(
    answerText: string,
    records: ToolCallRecord[],
  ): AgentResponse {
    const response: AgentResponse = {
      agent_name: this.name,
      role: this.role,
      message: answerText.trim(),
      next_agent: null,
      done: true,
      used_rag: this.RAGRetriever.callCount > 0,
    };
    if (records.length > 0) {
      response.tool_calls = records;
    }
    return response;
  }

  /**
   * 回答一次：Phase 1 工具循环（复用 runToolLoop）+ Phase 2 纯文本流式收尾。
   * 与 BaseAgent.invoke 不同——不结构化、不路由，产出 done=true 的单条回复。
   */
  async answer(
    requirement: string,
    conversationHistory: string,
    opts?: AnswerOptions,
  ): Promise<AgentResponse> {
    const requirement_cleaned = cleanBadChars(requirement);
    const history_cleaned = cleanBadChars(conversationHistory);
    // 清零本轮 RAG 调用计数（used_rag 据此判定）
    this.RAGRetriever.restart();

    const memoryPrompt = memorySection(opts?.userMemory ?? "");
    const systemPrompt = cleanBadChars(memoryPrompt + this.systemPrompt);
    const userPrompt = cleanBadChars(
      this._assistantUserPrompt(requirement_cleaned, history_cleaned),
    );

    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ];
    const toolCallRecords: ToolCallRecord[] = [];

    // ===== Phase 1：工具循环（与左侧 agent 同一套）=====
    try {
      await runToolLoop(this._modelWithTools, messages, toolCallRecords, {
        callerName: this.name,
        agentName: this.name,
        expansionTerms: opts?.expansionTerms,
        onToolUse: opts?.onToolUse,
        onToolResult: opts?.onToolResult,
        onToolApproval: opts?.onToolApproval,
      });
    } catch (exc) {
      logger.error(`[${this.name}] Phase 1 工具循环失败: ${String(exc)}`);
      return this._buildAssistantResponse(
        `(回答助手调用失败: ${String(exc)})`,
        toolCallRecords,
      );
    }

    // ===== Phase 2：纯文本收尾（不结构化、不路由）=====
    const wrapUpPrompt =
      "请基于以上对话与（若有）工具结果，直接用自然语言回答用户。" +
      "不要输出 JSON、不要分派任何角色、不要加 [NEXT_AGENT] / [DONE] 之类标记，正常对话即可。";
    messages.push(new HumanMessage(wrapUpPrompt));

    let answerText = "";
    try {
      if (opts?.onDelta) {
        // 流式：逐 chunk 吐 content 增量（真·打字机），无需结构化 diff
        const stream = await this._model.stream(messages);
        for await (const chunk of stream) {
          const piece = typeof chunk.content === "string" ? chunk.content : "";
          if (piece) {
            answerText += piece;
            opts.onDelta(piece);
          }
        }
      } else {
        // 非流式（CLI）：一次拿完整结果
        const out = await this._model.invoke(messages);
        answerText = typeof out.content === "string" ? out.content : String(out.content);
      }
    } catch (exc) {
      logger.error(`[${this.name}] Phase 2 收尾失败: ${String(exc)}`);
      answerText = `(回答助手收尾失败: ${String(exc)})`;
    }

    return this._buildAssistantResponse(answerText, toolCallRecords);
  }
}
