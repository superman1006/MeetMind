/**
 * 本地意图识别（zero-shot 分类，走 @huggingface/transformers，无需联网 / 无需 API key）。
 *
 * 用一个多语 NLI 模型（默认 `Xenova/mDeBERTa-v3-base-mnli-xnli`）做 zero-shot：
 * 给一句话 + 一组候选意图标签，模型逐条算「这句话蕴含『意图是 X』」的概率，取最高分的标签。
 * 这就是「小分类模型做意图」在本仓库无 torch 栈里的等价实现——不需要标注数据 / 训练。
 *
 * 与 embedding / reranker 共用 `settings.embeddingCacheDir` 作为模型缓存目录；首次启动会下载
 * 模型权重（q8 约 400MB），之后只从磁盘读。失败时返回 null，由上游 intent_node 当作「无信号」降级。
 */

import {
  type ZeroShotClassificationPipeline,
  env as hfEnv,
  pipeline,
} from "@huggingface/transformers";

import { getSettings } from "../../config/settings.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger("database.intent");

let _classifierPromise: Promise<ZeroShotClassificationPipeline> | null = null;

/**
 * 加载 zero-shot-classification pipeline，单例缓存。对标 embedding / reranker 端的 lazy 单例。
 */
function loadClassifier(): Promise<ZeroShotClassificationPipeline> {
  if (_classifierPromise !== null) {
    return _classifierPromise;
  }

  const settings = getSettings();
  // 把参数传给 hfEnv 的 env 对象
  hfEnv.cacheDir = settings.embeddingCacheDir;
  hfEnv.allowRemoteModels = true;
  hfEnv.allowLocalModels = true;

  const modelName = settings.intentModelName;
  // settings.intentDtype 是 string，按 pipeline 选项要求的字面量联合类型收窄（从签名推导，版本无关）
  type PipelineOptions = NonNullable<Parameters<typeof pipeline>[2]>;
  const dtype = settings.intentDtype as PipelineOptions["dtype"];
  logger.info(`[intent] 加载本地 zero-shot 模型 ${modelName}（dtype=${settings.intentDtype}）`);

  _classifierPromise = pipeline("zero-shot-classification", modelName, {
    dtype,
  }) as Promise<ZeroShotClassificationPipeline>;

  _classifierPromise.then(() => {
    logger.info(`[intent] 模型加载完成`);
  });

  return _classifierPromise;
}

/** 单条意图分类的结果：命中的标签 + 该标签的概率分（0~1）+ 全部候选的完整排名（按分降序）。 */
export interface IntentResult {
  label: string;
  score: number;
  // 全部候选标签的得分，已按分数从高到低对齐；供上游打日志展示完整分布。
  ranking: { label: string; score: number }[];
}

/**
 * 对一句话在给定候选标签里做 zero-shot 意图分类，返回最高分的那个标签 + 完整排名。
 * 失败（模型加载 / 前向 / 空输入）时返回 null，让 intent_node 降级为「无意图信号」。
 */
export async function classifyIntent(
  text: string,
  labels: readonly string[],
): Promise<IntentResult | null> {
  const trimmed = text.trim();
  if (!trimmed || labels.length === 0) {
    return null;
  }

  try {
    // 加载意图分类器
    const classifier = await loadClassifier();
    // 将 labels 转换为数组
    const candidateLabels = Array.from(labels);
    // 调用意图分类器
    const output = await classifier(trimmed, candidateLabels, {
      hypothesis_template: "这条输入的意图是{}。",
      multi_label: false,
    });

    // 取出 labels / scores（模型已按分数降序对齐两个数组），组成完整排名
    const single = Array.isArray(output) ? output[0] : output;
    const topLabel = single.labels[0];
    const topScore = single.scores[0];
    if (typeof topLabel !== "string" || typeof topScore !== "number") {
      return null;
    }
    const ranking: { label: string; score: number }[] = [];
    for (let i = 0; i < single.labels.length; i++) {
      ranking.push({ label: single.labels[i], score: single.scores[i] });
    }
    return { label: topLabel, score: topScore, ranking };
  } catch (exc) {
    logger.warning(`[intent] 本地意图分类失败: ${String(exc)}；本轮按无意图信号处理`);
    return null;
  }
}
