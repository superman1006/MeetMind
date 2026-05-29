/**
 * 本地 cross-encoder 重排（走 @huggingface/transformers，无需联网 / 无需 API key）。
 *
 * 混合检索（pg_trgm 关键字 + pgvector dense kNN）拉出 top-N 候选后，调本模块用一个 cross-encoder
 * 模型（默认 `Xenova/bge-reranker-base`）逐条算 query↔候选 的相关性分，排序取 top-K 给 LLM。
 *
 * 与 embedding 共用 `settings.embeddingCacheDir` 作为模型缓存目录；首次启动会下载模型权重，
 * 之后只从磁盘读。函数签名与返回结构和旧 Cohere 版完全一致，上游 rag_retriever 无需改动。
 */

import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env as hfEnv,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";

import { getSettings } from "../config/settings.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("database.reranker");

export interface RerankedDoc {
  /** 原候选列表里的下标 */
  index: number;
  /** 归一化到 0~1 的相关性分数（sigmoid 后） */
  relevanceScore: number;
}

interface LoadedReranker {
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
}

let _rerankerPromise: Promise<LoadedReranker> | null = null;

/**
 * 加载 tokenizer + cross-encoder 模型，单例缓存。对标 embedding 端的 lazy 单例。
 */
function loadReranker(): Promise<LoadedReranker> {
  if (_rerankerPromise !== null) {
    return _rerankerPromise;
  }

  const settings = getSettings();
  // 模型缓存目录复用 embedding 的（同一个 ./models/）
  hfEnv.cacheDir = settings.embeddingCacheDir;
  hfEnv.allowRemoteModels = true;
  hfEnv.allowLocalModels = true;

  const modelName = settings.rerankModelName;
  // settings.rerankDtype 是 string，按模型加载选项要求的字面量联合类型收窄（从函数签名推导，版本无关）
  type ModelLoadOptions = NonNullable<
    Parameters<typeof AutoModelForSequenceClassification.from_pretrained>[1]
  >;
  const dtype = settings.rerankDtype as ModelLoadOptions["dtype"];
  logger.info(`[reranker] 加载本地 cross-encoder ${modelName}（dtype=${settings.rerankDtype}）`);

  _rerankerPromise = (async () => {
    const tokenizer = await AutoTokenizer.from_pretrained(modelName);
    const model = await AutoModelForSequenceClassification.from_pretrained(modelName, {
      dtype,
    });
    logger.info(`[reranker] 模型加载完成`);
    const loaded: LoadedReranker = { tokenizer, model };
    return loaded;
  })();

  return _rerankerPromise;
}

/**
 * sigmoid：把 cross-encoder 的原始 logit 映射到 0~1，语义上对齐旧 Cohere relevanceScore。
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * 用本地 cross-encoder 对候选文档按 query 重排序。
 * 返回长度 ≤ topN 的 RerankedDoc 列表，按 relevanceScore 从高到低。
 * 失败时降级为「按原序返回前 N 条」，分数填 0。
 */
export async function rerank(
  query: string,
  documents: string[],
  topN?: number,
): Promise<RerankedDoc[]> {
  if (documents.length === 0) {
    return [];
  }

  const settings = getSettings();
  const requested = topN ?? settings.rerankTopN;
  const effectiveTopN = Math.min(requested, documents.length);

  let scores: number[];
  try {
    const { tokenizer, model } = await loadReranker();

    // 把同一个 query 复制成与候选等长的数组，和候选逐条配对成 cross-encoder 输入
    const queries: string[] = [];
    for (let i = 0; i < documents.length; i++) {
      queries.push(query);
    }
    const inputs = tokenizer(queries, {
      text_pair: documents,
      padding: true,
      truncation: true,
    });

    // 一次前向，每条候选输出一个相关性 logit
    const output = await model(inputs);
    const logits = output.logits;
    const dims = logits.dims;
    const numLabels = dims[dims.length - 1];
    const flat = logits.data as Float32Array;

    // 逐条候选取出 logit → sigmoid。num_labels==1 直接取；多分类取最后一类作为相关性
    scores = [];
    for (let i = 0; i < documents.length; i++) {
      let raw: number;
      if (numLabels === 1) {
        raw = flat[i];
      } else {
        raw = flat[i * numLabels + (numLabels - 1)];
      }
      const normalized = sigmoid(raw);
      scores.push(normalized);
    }
  } catch (exc) {
    logger.warning(
      `[reranker] 本地 rerank 失败: ${String(exc)}；降级为返回前 ${effectiveTopN} 条原序`,
    );
    const fallback: RerankedDoc[] = [];
    for (let i = 0; i < effectiveTopN; i++) {
      fallback.push({ index: i, relevanceScore: 0 });
    }
    return fallback;
  }

  // 把分数和原下标绑定，按分数降序排，取前 effectiveTopN 条
  const scored: RerankedDoc[] = [];
  for (let i = 0; i < scores.length; i++) {
    scored.push({ index: i, relevanceScore: scores[i] });
  }
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const out = scored.slice(0, effectiveTopN);

  if (out.length > 0) {
    logger.info(
      `[reranker] ${documents.length} 候选 → rerank → ${out.length} 条 (top score ${out[0].relevanceScore.toFixed(3)})`,
    );
  }
  return out;
}
