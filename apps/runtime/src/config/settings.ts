/**
 * 基于 zod 的应用配置，从环境变量 / .env 加载。
 * 含相对路径锚定到 PROJECT_ROOT 的逻辑。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// settings.ts 现位于 apps/runtime/src/config/settings.ts（编译后 dist 同深度），
// 向上四级 config→src→runtime→apps 才是仓库根（data/ models/ .env 都在根，两个 app 共享）
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

// 先加载 .env，再让 schema 读 process.env
loadDotenv({ path: path.join(PROJECT_ROOT, ".env") });

/**
 * 把相对路径解析为相对 PROJECT_ROOT 的绝对路径。
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

  // ---------- 本地意图识别（zero-shot NLI，走 @huggingface/transformers）----------
  // 默认 mDeBERTa-v3-base-mnli-xnli：多语 NLI（含中文），ONNX 版做 zero-shot 意图分类；
  // 模型缓存复用 embeddingCacheDir，首次约 400MB。无 torch 依赖，纯 ONNX。
  intentModelName: z.string().default("Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7"),
  // ONNX 量化精度：q8 体积小、意图粗分类对量化不敏感；要更准可设 fp32
  intentDtype: z.string().default("q8"),
  // 右侧分流阈值：意图命中「闲聊 / 知识问答」且置信分 ≥ 此值，才走「回答助手」单节点；
  // 否则（低置信 / 其它意图 / 分类失败）一律落回架构师全团队。NLI 偏脆，阈值给得保守一点更稳。
  intentRouteThreshold: z.coerce.number().default(0.5),

  // ---------- 检索参数 ----------
  retrieveTopN: z.coerce.number().default(20),
  rerankTopN: z.coerce.number().default(5),

  // ---------- Web 搜索（百度 AI Search MCP，SSE 传输）----------
  // MCP SSE 端点（不含 api_key），实际请求时会拼成 `<url>?api_key=<key>`
  baiduSearchMcpUrl: z
    .string()
    .default("https://appbuilder.baidu.com/v2/ai_search/mcp/sse"),
  // AppBuilder API Key；为空时 web_search 工具直接返回未配置提示，不会拦截启动
  baiduSearchApiKey: z.string().default(""),

  // ---------- 日志 / 安全阀 ----------
  logLevel: z.string().default("INFO"),
  maxIterations: z.coerce.number().default(15),
});

export type Settings = z.infer<typeof SettingsSchema>;

let _cached: Settings | null = null;

// 前端运行期下发的 LLM 模型覆盖（apiKey / baseUrl / modelName）。
// 优先级高于 .env：setModelOverrides 写进来后清掉 _cached，下次 getSettings 重新 parse 并并入。
// 进程内内存态，重启即失效（如需持久化可回写 .env，本期不做）。
const _modelOverrides: { apiKey?: string; baseUrl?: string; modelName?: string } = {};

/**
 * 单例配置访问器（首次 parse 后缓存复用）。
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
    intentModelName: process.env.INTENT_MODEL_NAME,
    intentDtype: process.env.INTENT_DTYPE,
    intentRouteThreshold: process.env.INTENT_ROUTE_THRESHOLD,
    retrieveTopN: process.env.RETRIEVE_TOP_N,
    rerankTopN: process.env.RERANK_TOP_N,
    baiduSearchMcpUrl: process.env.BAIDU_SEARCH_MCP_URL,
    baiduSearchApiKey: process.env.BAIDU_SEARCH_API_KEY,
    logLevel: process.env.LOG_LEVEL,
    maxIterations: process.env.MAX_ITERATIONS,
  };

  // 把 undefined / 空字符串字段剔掉，让 zod 走 default。
  // 注意：.env 里写 `KEY=`（留空）会给出空串 "" 而非 undefined，若不一并剔除就会
  // 绕过 zod 的 .default(...)（default 只对 undefined 生效），导致「留空 ≠ 用默认值」
  // 反而落成空值（如空模型名 / MAX_TOKENS 被 coerce 成 0）。统一把空串也当作未设置。
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) {
      continue;
    }
    if (typeof v === "string" && v.trim() === "") {
      continue;
    }
    filtered[k] = v;
  }

  const parsed = SettingsSchema.parse(filtered); // 校验并填默认

  // 把前端动态下发的模型覆盖叠加到解析结果上（优先级高于 .env）
  const merged: Settings = { ...parsed };
  if (_modelOverrides.apiKey !== undefined) {
    merged.apiKey = _modelOverrides.apiKey;
  }
  if (_modelOverrides.baseUrl !== undefined) {
    merged.baseUrl = _modelOverrides.baseUrl;
  }
  if (_modelOverrides.modelName !== undefined) {
    merged.modelName = _modelOverrides.modelName;
  }

  _cached = merged; // 缓存为单例
  return _cached;
}

/**
 * 设置前端下发的 LLM 模型覆盖。只接受非空字符串的字段，其余保持原值。
 * 写入后清空 _cached，使下次 getSettings() 重新合并出新配置。
 * 注意：agent 只在构造阶段读 settings，调用方改完覆盖后需自行重建 graph 才会真正生效。
 */
export function setModelOverrides(overrides: {
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
}): void {
  if (typeof overrides.apiKey === "string" && overrides.apiKey) {
    _modelOverrides.apiKey = overrides.apiKey;
  }
  if (typeof overrides.baseUrl === "string" && overrides.baseUrl) {
    _modelOverrides.baseUrl = overrides.baseUrl;
  }
  if (typeof overrides.modelName === "string" && overrides.modelName) {
    _modelOverrides.modelName = overrides.modelName;
  }
  _cached = null;
}

/**
 * 读取当前生效的 LLM 模型配置，供前端设置面板回填。
 * apiKey 不明文返回：apiKeyMasked 仅保留尾 4 位，apiKeySet 表示是否已配置。
 */
export function getCurrentModelConfig(): {
  baseUrl: string;
  modelName: string;
  apiKeyMasked: string;
  apiKeySet: boolean;
} {
  const s = getSettings();
  let masked = "";
  if (s.apiKey.length > 0 && s.apiKey.length <= 4) {
    masked = "****";
  } else if (s.apiKey.length > 4) {
    masked = "****" + s.apiKey.slice(-4);
  }
  return {
    baseUrl: s.baseUrl,
    modelName: s.modelName,
    apiKeyMasked: masked,
    apiKeySet: s.apiKey.length > 0,
  };
}

/**
 * 仅供启动诊断时打印用：遍历 Settings 的字段名。
 */
export function settingFieldNames(): readonly string[] {
  return Object.keys(SettingsSchema.shape);
}
