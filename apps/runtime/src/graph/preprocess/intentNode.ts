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

import { INTENT_LABELS } from "../../config/constants.js";
import { classifyIntent } from "../../database/models/intentClassifier.js";
import { getLogger } from "../../utils/logger.js";
import { cleanBadChars } from "../../utils/utils.js";
import type { AgentState } from "../state.js";

const logger = getLogger("graph.intent");

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

    const result = await classifyIntent(text, INTENT_LABELS);
    const intent = result?.label ?? "";
    // 命中标签的置信分，连同 label 一起写进 state，供下游 route_node 做阈值分流。
    const intentScore = result?.score ?? 0;

    // 展示处理后的内容：待分类文本 + 命中意图 + 全部候选的得分分布（按分降序）
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
    return { intent, intent_score: intentScore };
  };
}
