/**
 * 会话标题摘要：新会话首条用户输入 → LLM 总结成一个简短标题(≤15 字)。
 *
 * 与架构师讨论各自独立调一次 LLM、互不阻塞。失败 / 超时 / 空标题时返回空串，
 * 由调用方(rpcServer)决定不改标题，绝不抛断讨论。
 */
import { ChatOpenAI } from "@langchain/openai";

import { getSettings } from "../config/settings.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.titleSummary");

/** 标题最大字数(也写进提示词的「N 个字以内」)。 */
const TITLE_MAX_LEN = 15;

/**
 * 清洗 LLM 返回的标题：去掉所有换行 → 去首尾空白 → 兜底截断到 maxLen 字。
 * 纯函数，便于单测。按 Unicode 码点计数/截断(中文每字 1 个码点)。
 */
export function cleanTitle(raw: string, maxLen: number = TITLE_MAX_LEN): string {
  let text = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\n" || ch === "\r") {
      continue;
    }
    text += ch;
  }
  const trimmed = text.trim();
  const chars = [...trimmed];
  if (chars.length <= maxLen) {
    return trimmed;
  }
  return chars.slice(0, maxLen).join("");
}

/** 从 LLM 回复的 content 里取出纯文本(content 可能是字符串，也可能是分段数组)。 */
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

/**
 * 让 LLM 把用户输入总结成一个简短的会话标题。
 * 现读 settings(model.set 热切换后自动生效)，构造轻量探针模型：不重试、给超时，
 * 避免错误配置把请求挂死；thinking 关闭与正式 agent 保持一致。
 * 任何异常都内部 catch 并返回空串，调用方据此保留默认标题。
 */
export async function summarizeTitle(requirement: string): Promise<string> {
  const settings = getSettings();
  if (!settings.apiKey || !settings.baseUrl || !settings.modelName) {
    return "";
  }
  const model = new ChatOpenAI({
    apiKey: settings.apiKey,
    configuration: { baseURL: settings.baseUrl },
    model: settings.modelName,
    maxTokens: 64,
    temperature: 0,
    maxRetries: 0,
    timeout: 15000,
    modelKwargs: { thinking: { type: "disabled" } },
  });
  const prompt =
    `这是用户输入：${requirement}\n` +
    `请你将它总结成一个简短的会话标题，要求 ${TITLE_MAX_LEN} 个字以内，` +
    `只返回标题本身，不要换行、不要标点符号、不要解释。`;
  try {
    const response = await model.invoke(prompt);
    const raw = extractText(response.content);
    return cleanTitle(raw);
  } catch (exc) {
    logger.warning(`[titleSummary] 标题摘要失败: ${String(exc)}`);
    return "";
  }
}
