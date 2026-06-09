/**
 * rewrite_node —— 预处理流水线第一步：query 改写。
 *
 * 做两件事，产出独立、可检索的 query：
 *   1. 指代消解 / 上下文改写：用最近几轮历史把用户最新输入里的代词、省略补全成一句
 *      不依赖上下文即可理解的独立句 → 写进 state.rewritten_query，供各 agent 阅读 + 生成。
 *   2. Query Expansion：补充同义 / 相关关键词 → 写进 state.expansion_terms，仅供检索层
 *      （rag_search）拼到 query 后面提升召回，不进 agent 的阅读 prompt（避免同义词噪声干扰生成）。
 *
 * 用 LLM 的 withStructuredOutput 一次产出两字段。失败时降级为「rewritten_query=原始输入、
 * expansion_terms=空」，绝不让预处理拖垮整轮（对齐仓库各处的失败降级风格）。
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import type { AgentResponse } from "../../agents/base.js";
import { getSettings } from "../../config/settings.js";
import { getLogger } from "../../utils/logger.js";
import { cleanBadChars } from "../../utils/utils.js";
import type { AgentState } from "../state.js";

const logger = getLogger("graph.rewrite");

/** 改写器的结构化输出：独立句 + 扩展关键词。刻意单层，和 ModelOutputSchema 一样稳。 */
const RewriteOutputSchema = z.object({
  // 改写后的独立句
  rewritten_query: z
    .string()
    .describe(
      "把用户最新输入改写成一句独立、完整、脱离上下文也能看懂的话：" +
        "消解其中的代词指代（它 / 这个 / 那个…），补全省略的主语 / 宾语 / 话题。" +
        "若输入本身已经完整，或只是闲聊 / 打招呼，就原样返回，不要画蛇添足。",
    ),
  // 扩展关键词
  expansion_terms: z
    .string()
    .describe(
      "为提升检索召回补充的同义词 / 相关关键词，空格分隔；" +
        "不要重复 rewritten_query 里已有的词；没有合适的就返回空字符串。",
    ),
});

/** 取最近 maxTurns 条发言拼成紧凑历史，给改写器做指代消解的上下文（太久远的轮次对消解无益）。 */
function formatRecentHistory(messages: AgentResponse[], maxTurns = 6): string {
  if (messages.length === 0) {
    return "";
  }
  // 计算起始位置
  const start = Math.max(0, messages.length - maxTurns);
  // 获取最近 maxTurns 条发言的切片
  const recent = messages.slice(start);
  // 将最近 maxTurns 条发言拼成紧凑历史,每个发言的格式为：agent_name: message
  const chunks: string[] = [];
  for (const m of recent) {
    chunks.push(`${m.agent_name}: ${m.message}`);
  }
  return chunks.join("\n");
}

const SYSTEM_PROMPT =
  "你是一个查询改写器，服务于一个多 agent 讨论系统。" +
  "你的唯一职责是把用户最新一句输入改写得『独立、完整、可检索』，并补充检索用的扩展词。" +
  "你不回答用户的问题，也不发表意见，只输出改写结果。";

/**
 * 构造 rewrite_node 节点函数。
 * 在 buildGraph 阶段调用一次，内部建好 LLM（读 settings，和各 agent 一样构造期取值）。
 */
export function createRewriteNode() {
  const settings = getSettings();
  const model = new ChatOpenAI({
    apiKey: settings.apiKey,
    configuration: { baseURL: settings.baseUrl },
    model: settings.modelName,
    maxTokens: settings.maxTokens,
    temperature: 0, // 改写要稳定可复现，温度拉到 0
    // 关闭后端 thinking 模式（OpenAI 兼容协议扩展字段，全项目统一保留）
    modelKwargs: { thinking: { type: "disabled" } },
  });
  const structuredModel = model.withStructuredOutput(RewriteOutputSchema, {
    name: "RewriteOutput",
  });

  return async (state: AgentState): Promise<Partial<AgentState>> => {
    const original = cleanBadChars(state.requirement ?? "");
    // 空输入：不调模型，直接给空结果（下游会兜底回 requirement）
    if (!original.trim()) {
      return { rewritten_query: "", expansion_terms: "" };
    }

    const history = cleanBadChars(formatRecentHistory(state.messages ?? []));
    // 构造用户提示
    const userPrompt =
      `最近讨论历史（用于消解指代，可能为空）：\n${history || "(尚无历史)"}\n\n` +
      `用户最新输入：${original}\n\n` +
      "请输出 RewriteOutput 两字段：rewritten_query（独立句）和 expansion_terms（扩展词，可为空）。";

    try {
      // 调用结构化模型
      const out = await structuredModel.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(userPrompt),
      ]);
      // 改写结果为空时兜底回原始输入，保证 rewritten_query 永远可用
      const rewritten = (out.rewritten_query ?? "").trim() || original;
      const terms = (out.expansion_terms ?? "").trim();
      // 展示处理后的内容：原始输入 → 改写后的独立句 + 检索扩展词（完整展示，不截断）
      const changed = rewritten === original ? "（与原文一致）" : "";
      logger.info(
        `[rewrite] 改写完成\n` +
          `    原始输入  : ${original}\n` +
          `    改写结果  : ${rewritten} ${changed}\n` +
          `    扩展关键词: ${terms || "(无)"}`,
      );
      return { rewritten_query: rewritten, expansion_terms: terms };
    } catch (exc) {
      logger.error(`[rewrite] 改写失败: ${String(exc)}；降级为原始输入、无扩展词`);
      return { rewritten_query: original, expansion_terms: "" };
    }
  };
}
