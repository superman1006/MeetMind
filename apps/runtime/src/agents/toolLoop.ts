/**
 * 工具调用循环（Phase 1）——从 BaseAgent.invoke 抽出来的公共能力。
 *
 * 让一个已 bindTools 的模型自主决定调不调工具：调了就按名字在 allTools 里找到工具执行、
 * 把结果包成 ToolMessage 接回去，直到模型不再要工具，或达到 MAX_TOOL_ITERATIONS 上限。
 *
 * 抽成模块级函数是为了让「架构师那套协作 agent」（base.ts）和「右侧回答助手单节点」（assistant.ts）
 * 共用同一套工具循环 + HITL 审批逻辑，而不必各写一份。函数只负责往 messages / records 里追加，
 * 不做结构化收尾、不决定 next_agent——那是各调用方自己的事（协作 agent 走 Phase 2，助手走纯文本流式）。
 *
 * LLM 调用出错时直接抛出，由调用方按各自语义兜底（base 返回占位 AgentResponse，助手返回占位文本）。
 */

import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { Runnable } from "@langchain/core/runnables";

import { getLogger } from "../utils/logger.js";
import { allTools } from "../tools/toolRegister.js";
import type { ToolCallRecord } from "./base.js";

const logger = getLogger("agents.toolLoop");

/** 单轮最多放任模型调几次工具，超过强制收尾，避免卡死在工具调用上。 */
export const MAX_TOOL_ITERATIONS = 10;

/** 工具循环的回调 + 透传项。callerName 仅用于日志；agentName 经 config 透传给工具区分私有表。 */
export interface ToolLoopOptions {
  // 打日志用的调用方名字（如 architect / assistant）。
  callerName: string;
  // 透传给工具的 agent 名：rag_search 据此查对应私有表（助手无私有表时检索自然返回空，已降级处理）。
  agentName: string;
  // rewrite_node 产出的检索扩展词，经 config 透传给 rag_search 拼到 query 后面提升召回。
  expansionTerms?: string;
  // 工具执行前通知（前端显示 "UsingTools: <工具名>" 标签）。
  onToolUse?: (toolName: string) => void;
  // 工具执行后回调（name/args/result），前端据此加按钮 + 展开结果。
  onToolResult?: (rec: ToolCallRecord) => void;
  // risk>low 的工具执行前调一次，返回用户是否同意。给了才启用 HITL 审批；没给则直接执行。
  onToolApproval?: (info: {
    toolName: string;
    risk: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;
}

/**
 * 跑工具循环：把模型产出的 AIMessage / 执行得到的 ToolMessage 追加进 messages，
 * 把每次工具调用明细追加进 records。原地修改这两个数组。
 *
 * 返回值：模型「主动停手」那一轮（toolCalls 为空）的纯文本 content——也就是它本轮
 * 不调工具、直接拟好的回答。调用方（base.ts）会把它作为 Phase 2 content 的种子，
 * 避免「直接答案只活在 Phase 1 不可见的 assistant 文本里」而丢失。
 * 若因达到次数上限被强制收尾（末尾是 ToolMessage 而非干净的回答），返回空串。
 */
export async function runToolLoop(
  modelWithTools: Runnable,
  messages: BaseMessage[],
  records: ToolCallRecord[],
  opts: ToolLoopOptions,
): Promise<string> {
  // exhausted：是否因为达到次数上限才退出（而非模型主动停手）。仅用于打一条提醒日志。
  let exhausted = true;
  // finalText：模型主动停手那轮的纯文本回答；只有干净收尾（无 tool_call）时才有值。
  let finalText = "";
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const aiMsg = (await modelWithTools.invoke(messages)) as AIMessage;
    messages.push(aiMsg);

    // 模型不再要工具，结束循环
    const toolCalls: ToolCall[] = aiMsg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      exhausted = false;
      // content 可能是 string 或 content blocks 数组；只取干净的字符串，拿不到就留空串
      finalText = typeof aiMsg.content === "string" ? aiMsg.content : "";
      break;
    }

    for (const tc of toolCalls) {
      const toolName = tc.name ?? "";
      const toolArgs = tc.args ?? {};
      const toolId = tc.id ?? "";

      // 按名字从工具列表里找到要执行的工具
      let toolToRun = undefined;
      for (const t of allTools) {
        if (t.name === toolName) {
          toolToRun = t;
          break;
        }
      }

      // 未知工具（名字不在 allTools 里，模型有时会幻觉出不存在的工具）：跳过本次调用，
      // 不执行、不记录(records)、不回调前端(onToolResult)。但仍要给这个 tool_call_id 回一条
      // ToolMessage 占位——否则 OpenAI 协议会因 tool_call 没有对应结果而在下一轮 invoke 报错；
      // 占位里说明工具不存在，引导模型别再调它。
      if (!toolToRun) {
        logger.warning(
          `[${opts.callerName}] 模型调用了未知工具 ${toolName}，已跳过本次调用`,
        );
        const skipHint = `(未知工具，已跳过: ${toolName})`;
        messages.push(new ToolMessage({ content: skipHint, tool_call_id: toolId }));
        continue;
      }

      logger.info(
        `[${opts.callerName}] → 调用工具 ${toolName} args=${JSON.stringify(toolArgs)}`,
      );
      // 工具的 risk 等级（自定义元数据，见各 *Tool.ts）；缺省视为 low。
      const toolMeta = (toolToRun as { metadata?: Record<string, unknown> }).metadata;
      const risk = (toolMeta?.risk as string | undefined) ?? "low";
      // HITL 审批：risk 高于 low 且上层提供了 onToolApproval 时，执行前先等用户拍板。
      let approved = true;
      if (risk !== "low" && opts.onToolApproval) {
        approved = await opts.onToolApproval({
          toolName,
          risk,
          args: toolArgs as Record<string, unknown>,
        });
      }
      let toolResult: string;
      if (!approved) {
        // 用户拒绝：跳过执行。仍要给这次 tool_call 一个结果（否则 OpenAI 协议
        // 会因 tool_call_id 没有对应 ToolMessage 而报错），用一句占位说明代替。
        toolResult = "(用户拒绝使用该工具)";
      } else {
        // 工具执行前通知前端显示 "UsingTools: <工具名>" 标签
        opts.onToolUse?.(toolName);
        // 通过 config 把 agent 名 + 检索扩展词传给工具
        // （rag_search 据 agentName 查对应私有表、据 expansionTerms 扩展 query；其它工具忽略）
        const out = await toolToRun.invoke(toolArgs, {
          configurable: {
            agentName: opts.agentName,
            expansionTerms: opts.expansionTerms ?? "",
          },
        });
        // 工具 invoke 可能返回 string 或 ToolMessage；统一收敛成字符串
        toolResult = typeof out === "string" ? out : JSON.stringify(out);
      }
      // 记下这次调用的明细(name/args/result)：收集起来落库，并实时回调给前端加按钮
      const record: ToolCallRecord = {
        name: toolName,
        args: toolArgs as Record<string, unknown>,
        result: toolResult,
      };
      records.push(record);
      opts.onToolResult?.(record);
      messages.push(new ToolMessage({ content: toolResult, tool_call_id: toolId }));
    }
  }
  if (exhausted) {
    logger.warning(
      `[${opts.callerName}] 工具调用次数已达上限 (${MAX_TOOL_ITERATIONS})，强制进入收尾阶段`,
    );
  }
  return finalText;
}
