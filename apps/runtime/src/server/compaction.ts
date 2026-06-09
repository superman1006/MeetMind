/**
 * 上下文压缩（A 方案）：把会话「边界之前的历史」滚动总结成一份摘要，写进 sessions 行。
 *
 * 核心约定：压缩**不删 / 不改 messages 表**——它只是 UPDATE sessions 的 summary +
 * summarized_through_seq 两列，把「喂给 LLM 的历史」从全量截短成「摘要 + 边界后尾部」。
 * 前端展示历史仍走 getMessages（全量），不受影响。详见 chatStore.getContextMessages。
 *
 * 失败（模型调用异常 / 空摘要）时**不推进边界**：宁可这次不压、下次再试，也不能丢上下文。
 */
import { ChatOpenAI } from "@langchain/openai";

import { getSettings } from "../config/settings.js";
import type { AgentResponse } from "../agents/base.js";
import * as chatStore from "../database/chat/chatStore.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.compaction");

// 摘要生成的 token 上限（够装下一份结构化的讨论纪要）。
const SUMMARY_MAX_TOKENS = 1024;

/** 一次压缩的结果：是否真的压了、新边界、摘要长度，供 RPC 回给前端。 */
export interface CompactionResult {
  compacted: boolean;
  reason?: string;
  throughSeq?: number;
  summaryChars?: number;
}

/** 从 LLM 回复的 content 里取纯文本（content 可能是字符串，也可能是分段数组）。 */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object" && "text" in item && typeof (item as { text: unknown }).text === "string") {
        parts.push((item as { text: string }).text);
      }
    }
    return parts.join("");
  }
  return "";
}

/** 把要折进摘要的消息拼成纯文本转录，喂给压缩模型。 */
function formatForCompaction(messages: AgentResponse[]): string {
  const chunks: string[] = [];
  for (const m of messages) {
    chunks.push(`【${m.role}】(${m.agent_name})\n${m.message}`);
  }
  return chunks.join("\n\n");
}

/** 拼压缩提示词：旧摘要(可空) + 新增转录 → 让模型滚动产出一份更新后的摘要。 */
function buildCompactionPrompt(oldSummary: string, transcript: string): string {
  const lines: string[] = [];
  lines.push("你在压缩一场多角色（架构师 / 后端 / 前端 / 测试 / 产品经理）项目讨论的上下文。");
  lines.push("目标：把下面的内容浓缩成一份**简洁但信息完整**的摘要，供后续讨论作为背景记忆。");
  lines.push("务必保留：核心需求、已达成的设计决策、各角色的关键结论、未解决的问题 / 待办、重要的约束与数据。");
  lines.push("可以丢弃：寒暄、重复表述、过程性发言。用条理化的要点呈现，不要逐句复述。");
  lines.push("");
  if (oldSummary.trim()) {
    lines.push("【已有摘要（更早的历史，请与下面的新讨论合并、去重，产出一份新的整体摘要）】");
    lines.push(oldSummary.trim());
    lines.push("");
  }
  lines.push("【新增讨论转录】");
  lines.push(transcript);
  lines.push("");
  lines.push("请只输出更新后的摘要正文本身，不要前言、不要解释。");
  return lines.join("\n");
}

/**
 * 压缩某会话：读边界 → 取「边界之后、保留尾部之前」的消息折进摘要 → UPDATE sessions。
 * 由 chat.compact RPC 调用（前端在用量达 80% 时触发）。新消息不足以压（≤ KEEP_TAIL）时直接返回 compacted:false。
 */
export async function compactSession(sessionId: string): Promise<CompactionResult> {
  const settings = getSettings();
  if (!settings.apiKey || !settings.baseUrl || !settings.modelName) {
    return { compacted: false, reason: "LLM 未配置" };
  }

  const state = await chatStore.getCompactionState(sessionId);
  const maxSeq = await chatStore.getMaxSeq(sessionId);

  // 手动压缩：不做阈值判断，把边界之后所有未折进摘要的消息全部压掉，新边界推到当前最大 seq。
  const newThroughSeq = maxSeq;
  const toFold = await chatStore.getMessagesAfterSeq(sessionId, state.throughSeq);
  // 唯一会拦下的情况：边界之后压根没有消息（空会话 / 已经全压过），此时无内容可压、直接返回。
  if (toFold.length === 0) {
    return { compacted: false, reason: "没有可压缩的新内容" };
  }

  const transcript = formatForCompaction(toFold);
  const prompt = buildCompactionPrompt(state.summary, transcript);

  const model = new ChatOpenAI({
    apiKey: settings.apiKey,
    configuration: { baseURL: settings.baseUrl },
    model: settings.modelName,
    maxTokens: SUMMARY_MAX_TOKENS,
    temperature: 0.3,
    maxRetries: 1,
    timeout: 60000,
    modelKwargs: { thinking: { type: "disabled" } },
  });

  let newSummary = "";
  try {
    const response = await model.invoke(prompt);
    newSummary = extractText(response.content).trim();
  } catch (exc) {
    logger.error(`[compaction] 会话 ${sessionId} 压缩调用失败: ${String(exc)}`);
    return { compacted: false, reason: `压缩失败: ${String(exc)}` };
  }

  // 空摘要不推进边界：否则这段历史既不在摘要里、又被排除出尾部，等于凭空丢失。
  if (!newSummary) {
    logger.warning(`[compaction] 会话 ${sessionId} 摘要为空，跳过、不推进边界`);
    return { compacted: false, reason: "摘要为空" };
  }

  await chatStore.setCompaction(sessionId, newSummary, newThroughSeq);
  logger.info(`[compaction] 会话 ${sessionId} 已压缩：折进 ${toFold.length} 条，新边界 seq=${newThroughSeq}，摘要 ${newSummary.length} 字`);
  return { compacted: true, throughSeq: newThroughSeq, summaryChars: newSummary.length };
}
