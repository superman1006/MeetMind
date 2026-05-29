/**
 * 基于 zod 的应用配置，从环境变量 / .env 加载。
 * 对标 Python 端 pydantic-settings 的 Settings，含相对路径锚定到 PROJECT_ROOT 的逻辑。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// settings.ts 位于 src/config/settings.ts，向上两级是项目根
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// 先加载 .env，再让 schema 读 process.env
loadDotenv({ path: path.join(PROJECT_ROOT, ".env") });

/**
 * 把相对路径解析为相对 PROJECT_ROOT 的绝对路径。
 * 对标 Python 端 `@field_validator("seed_data_path", "embedding_cache_dir", mode="after")`。
 */
function resolveRel(p: string): string {
  if (path.isAbsolute(p)) {
    return p;
  }
  return path.resolve(PROJECT_ROOT, p);
}

const SettingsSchema = z.object({
  // ---------- LLM (OpenAI 兼容) ----------
  apiKey: z.string().default(""),
  baseUrl: z.string().default(""),
  modelName: z.string().default(""),
  maxTokens: z.coerce.number().default(2000),
  temperature: z.coerce.number().default(0.4),

  // ---------- 种子文件（输入） ----------
  seedDataPath: z.string().default("data/seed").transform(resolveRel),

  // ---------- PostgreSQL（存储 + pgvector 向量检索 + pg_trgm 关键字召回） ----------
  // 连接串形如 postgresql://user:pass@host:5432/dbname；默认指向 docker-compose 起的本地实例
  pgUrl: z.string().default("postgresql://meetmind:meetmind@localhost:5432/meetmind"),
  // 每个 agent 一张表，表名 `<prefix>_<agent>`
  pgTablePrefix: z.string().default("meetmind"),

  // ---------- Embedding ----------
  embeddingModelName: z.string().default("Xenova/all-MiniLM-L6-v2"),
  embeddingCacheDir: z.string().default("models").transform(resolveRel),

  // ---------- 本地 Rerank（cross-encoder，走 @huggingface/transformers）----------
  // 默认 bge-reranker-base：多语言 cross-encoder，中文效果好；模型缓存复用 embeddingCacheDir
  rerankModelName: z.string().default("Xenova/bge-reranker-base"),
  // ONNX 量化精度：q8 体积小（~280MB）且 rerank 分数对量化不敏感；要更准可设 fp32
  rerankDtype: z.string().default("q8"),

  // ---------- 检索参数 ----------
  retrieveTopN: z.coerce.number().default(20),
  rerankTopN: z.coerce.number().default(5),

  // ---------- 日志 / 安全阀 ----------
  logLevel: z.string().default("INFO"),
  maxIterations: z.coerce.number().default(15),
});

export type Settings = z.infer<typeof SettingsSchema>;

let _cached: Settings | null = null;

/**
 * 单例配置访问器。对标 Python 端 `@lru_cache(maxsize=1)` + `get_settings()`。
 */
export function getSettings(): Settings {
  if (_cached !== null) {
    return _cached;
  }

  // 注意：env 名仍按 .env 里的全大写 SNAKE，不引入额外别名，避免和 .env.example 失同步
  const raw = {
    apiKey: process.env.API_KEY,
    baseUrl: process.env.BASE_URL,
    modelName: process.env.MODEL_NAME,
    maxTokens: process.env.MAX_TOKENS,
    temperature: process.env.TEMPERATURE,
    seedDataPath: process.env.SEED_DATA_PATH ?? "data/seed",
    pgUrl: process.env.PG_URL,
    pgTablePrefix: process.env.PG_TABLE_PREFIX,
    embeddingModelName: process.env.EMBEDDING_MODEL_NAME,
    embeddingCacheDir: process.env.EMBEDDING_CACHE_DIR ?? "models",
    rerankModelName: process.env.RERANK_MODEL_NAME,
    rerankDtype: process.env.RERANK_DTYPE,
    retrieveTopN: process.env.RETRIEVE_TOP_N,
    rerankTopN: process.env.RERANK_TOP_N,
    logLevel: process.env.LOG_LEVEL,
    maxIterations: process.env.MAX_ITERATIONS,
  };

  // 把 undefined 字段剔掉，让 zod 走 default
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) {
      filtered[k] = v;
    }
  }

  _cached = SettingsSchema.parse(filtered); // 校验并填默认，缓存为单例
  return _cached;
}

/**
 * 仅供启动诊断时打印用：遍历 Settings 的字段名。
 */
export function settingFieldNames(): readonly string[] {
  return Object.keys(SettingsSchema.shape);
}
