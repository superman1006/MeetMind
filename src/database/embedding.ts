/**
 * 文本 → 稠密向量。
 *
 * 用 @huggingface/transformers (v3, JS 端) 在本地加载 `Xenova/all-MiniLM-L6-v2`（384 维），
 * 与 Python 端 sentence-transformers 同款模型，迁移后向量空间近似一致（ONNX vs PyTorch
 * 数值非逐位等同，但语义检索效果可用）。
 *
 * **模型缓存目录**走 `settings.embeddingCacheDir`（默认项目内 `./models/`），
 * 首次启动会下载约 80MB；之后只从磁盘读。
 */

import path from "node:path";
import {
  type FeatureExtractionPipeline,
  env as hfEnv,
  pipeline,
} from "@huggingface/transformers";

import { getSettings } from "../config/settings.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("database.embedding");

let _extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * 加载 feature-extraction pipeline，单例缓存。对标 Python 端 `@lru_cache(maxsize=1)`。
 */
export function getEmbedderModel(): Promise<FeatureExtractionPipeline> {
  if (_extractorPromise !== null) {
    return _extractorPromise;
  }

  const settings = getSettings();
  // 模型缓存目录，决定权重下载到哪
  hfEnv.cacheDir = settings.embeddingCacheDir;
  // 允许首次从远端下载；离线模式可在 .env 里加一个开关再设 env.allowRemoteModels=false
  hfEnv.allowRemoteModels = true;
  hfEnv.allowLocalModels = true;

  const modelName = settings.embeddingModelName;
  logger.info(`[embedding] 加载 ${modelName}（缓存目录: ${path.relative(process.cwd(), settings.embeddingCacheDir) || "."}）`);

  _extractorPromise = pipeline("feature-extraction", modelName, {
    // fp32 不量化，保证和 Python 端 384 维一致且数值接近
    dtype: "fp32",
  }) as Promise<FeatureExtractionPipeline>;

  // 加载完成后再打印维度（lazy）
  _extractorPromise.then(async (ex) => {
    try {
      const sample = await ex("dim probe", { pooling: "mean", normalize: true });
      logger.info(`[embedding] 加载完成，维度 ${sample.dims[sample.dims.length - 1] ?? "?"}`);
    } catch {
      // 加载完成提示失败不阻塞
    }
  });

  return _extractorPromise;
}

let _cachedDim: number | null = null;

/**
 * 返回当前模型的向量维度（建索引 mapping 时需要）。
 */
export async function getEmbedModelDim(): Promise<number> {
  if (_cachedDim !== null) {
    return _cachedDim;
  }
  const ex = await getEmbedderModel();
  const sample = await ex("dim probe", { pooling: "mean", normalize: true });
  const dim = sample.dims[sample.dims.length - 1];
  if (typeof dim !== "number") {
    throw new Error("无法从 embedding 输出推断维度");
  }
  _cachedDim = dim;
  return dim;
}

/**
 * 编码单条文本，返回归一化后的 number[]。
 */
export async function embed(text: string): Promise<number[]> {
  const ex = await getEmbedderModel();
  // mean pooling + 归一化，输出可直接做余弦检索
  const tensor = await ex(text, { pooling: "mean", normalize: true });
  // 单条输入：tensor.data 是一维 Float32Array，长度 = 384
  return Array.from(tensor.data as Float32Array);
}

/**
 * 批量编码；返回与输入等长的 number[][]。
 */
export async function embedBatch(
  texts: string[],
  batchSize = 32,
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const ex = await getEmbedderModel();
  const out: number[][] = [];

  // 分批喂入，避免一次性占用过多内存
  for (let i = 0; i < texts.length; i += batchSize) {
    const chunk = texts.slice(i, i + batchSize);
    const tensor = await ex(chunk, { pooling: "mean", normalize: true });
    // 批量输入：tensor 形状是 [batch, dim]
    const lastDim = tensor.dims[tensor.dims.length - 1];
    if (typeof lastDim !== "number") {
      throw new Error("embedding 批量输出形状异常");
    }
    const flat = tensor.data as Float32Array;
    for (let row = 0; row < chunk.length; row++) {
      const start = row * lastDim;
      const vec = Array.from(flat.subarray(start, start + lastDim));
      out.push(vec);
    }
  }

  return out;
}
