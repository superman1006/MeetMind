/**
 * intent_node —— 预处理流水线第二步：意图识别。
 *
 * 在 rewrite_node 之后跑：拿改写后的独立句（state.rewritten_query）去做 zero-shot 意图分类，
 * 把命中的标签写进 state.intent。「先改写、后意图」是有意为之——多轮里残缺句会让意图分类失准，
 * 先补全成独立句再分类更准。
 *
 * 用本地 BERT 系 NLI 模型（见 database/models/intentClassifier.ts），无需联网 / API key。
 * 分类失败返回空串，下游当作「无意图信号」——闲聊 / 问答仍由架构师按 prompt 自行处理，
 * 意图只是给 _userPrompt 的一句参考提示，不做硬路由（避免误判把正常需求挡在门外）。
 */

import {
  CHITCHAT_GREETINGS,
  CHITCHAT_PARTICLES,
  INTENT_CHITCHAT,
  INTENT_LABELS,
} from "../../config/constants.js";
import { classifyIntent } from "../../database/models/intentClassifier.js";
import { getLogger } from "../../utils/logger.js";
import { cleanBadChars } from "../../utils/utils.js";
import type { AgentState } from "../state.js";

const logger = getLogger("graph.intent");

/** 剥掉标点 / 空白（保留中文字符、字母、数字与语气词），用于把「你好，」「hi~」归一成裸问候语。 */
const PUNCT_AND_SPACE = /[\s,.!?;:'"`~@#$%^&*()_+\-=[\]{}|\\/<>，。！？；：、…—～·“”‘’（）《》【】]/g;

/** rest 是否「全部由可忽略的尾缀语气词组成」（供 matchChitchatRule 判定「你好啊」这类带尾缀的问候）。 */
function isAllParticles(rest: string): boolean {
  // 空串不在这里判（精确相等分支已覆盖），这里只处理「问候词 + 非空尾缀」
  if (!rest) {
    return false;
  }
  for (const ch of rest) {
    if (!CHITCHAT_PARTICLES.includes(ch)) {
      return false;
    }
  }
  return true;
}

/**
 * 规则短路：判断整句是否「基本就是一个问候语」（可带尾缀语气词、标点）。
 * 命中返回 true → intent_node 直接判「闲聊」、跳过脆弱的 zero-shot NLI（见 INTENT_LABELS 注释）。
 *
 * 刻意只认「整句精确匹配（去尾缀）」：先去掉标点 / 空白并转小写，再逐个白名单问候词比对——
 * 要么完全相等，要么「问候词 + 纯语气词尾缀」。所以「你好」「您好呀」「hi~」命中，
 * 而「你好，帮我设计登录系统」因为开头之后还有真实需求、不是纯语气词尾缀，不会命中（正确地放给团队）。
 */
export function matchChitchatRule(text: string): boolean {
  const lowered = text.toLowerCase();
  // 去掉所有标点与空白，得到裸串
  const normalized = lowered.replace(PUNCT_AND_SPACE, "");
  if (!normalized) {
    return false;
  }
  for (const greeting of CHITCHAT_GREETINGS) {
    const word = greeting.toLowerCase();
    // 完全相等：纯问候语
    if (normalized === word) {
      return true;
    }
    // 问候词 + 纯语气词尾缀（如 "你好啊" = "你好" + "啊"）
    if (normalized.startsWith(word)) {
      const rest = normalized.slice(word.length);
      if (isAllParticles(rest)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 构造 intent_node 节点函数。
 * 无需预建模型——分类器在 intentClassifier.ts 内部懒加载单例（对标 reranker）。
 */
export function createIntentNode() {
  return async (state: AgentState): Promise<Partial<AgentState>> => {
    // 优先用改写后的独立句（rewrite_node 已先跑）；为空兜底回原始输入
    const text = cleanBadChars(state.rewritten_query || state.requirement || "");
    if (!text.trim()) {
      return { intent: "", intent_score: 0 };
    }

    // 规则短路：明显的问候 / 寒暄直接判「闲聊」，不交给脆弱的 NLI（超短问候上 NLI 输出近噪声、常误判）。
    // 给满置信分 1，确保稳过 route_node 的阈值、分流到右侧回答助手。
    if (matchChitchatRule(text)) {
      logger.info(
        `[intent] 命中问候规则，短路判为「${INTENT_CHITCHAT}」（跳过 NLI）\n` +
          `    待分类文本: ${text}`,
      );
      return { intent: INTENT_CHITCHAT, intent_score: 1 };
    }

    // 开始意图识别
    const result = await classifyIntent(text, INTENT_LABELS);
    // 意图识别结果
    const intent = result?.label ?? "";
    // 命中标签的置信分，连同 label 一起写进 state，供下游 route_node 做阈值分流
    const intentScore = result?.score ?? 0;

    // 意图识别结果不为空时，打印意图识别结果
    if (result) {
      const rankLines: string[] = [];
      for (const item of result.ranking) {
        rankLines.push(`      - ${item.label}: ${item.score.toFixed(3)}`);
      }
      logger.info(
        `[intent] 意图识别完成\n` +
          `    待分类文本: ${text}\n` +
          `    命中意图  : ${intent} (${result.score.toFixed(3)})\n` +
          `    得分分布  :\n${rankLines.join("\n")}`,
      );
    } else {
      logger.info(
        `[intent] 意图识别无信号（分类失败 / 已降级）\n` +
          `    待分类文本: ${text}`,
      );
    }
    // 返回意图识别结果
    return { 
      intent, // 意图标签
      intent_score: intentScore, // 命中标签的置信分
    };
  };
}
