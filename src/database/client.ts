/**
 * PostgreSQL 连接池单例 + 每 agent 的表管理。
 *
 * 每个 agent 一张独立的表（默认名 `meetmind_<agent>`），列：
 *   - `id`        text 主键，内容 md5，保证灌库幂等
 *   - `content`   text，正文；关键字召回走 pg_trgm（word_similarity）
 *   - `metadata`  jsonb，来源信息（type / date / source ...）
 *   - `embedding` vector(dim)，维度由 embedding 模型决定 → pgvector kNN 向量检索
 *
 * 依赖两个扩展：`vector`（pgvector，向量检索）+ `pg_trgm`（trigram，关键字召回）。
 * 二者在 pgvector/pgvector 官方镜像里都可直接 `CREATE EXTENSION`。
 */

import pg from "pg";

import { getSettings } from "../config/settings.js";
import { getLogger } from "../utils/logger.js";
import { getTableName } from "./constants.js";
import { getEmbedModelDim } from "./embedding.js";

const { Pool } = pg;

const logger = getLogger("database.client");

let _pool: pg.Pool | null = null;

/**
 * 返回进程内单例的 PostgreSQL 连接池。对标旧 ES 端的单例 client。
 */
export function getPgPool(): pg.Pool {
  if (_pool !== null) {
    return _pool;
  }
  const settings = getSettings();
  _pool = new Pool({
    connectionString: settings.pgUrl,
    // 本地单机 demo，连接数不用太多
    max: 10,
  });
  // 池里某条连接异常时只记日志，不让进程崩
  _pool.on("error", (err) => {
    logger.warning(`[pg] 连接池错误: ${String(err)}`);
  });
  return _pool;
}

/**
 * 检查 PostgreSQL 是否可达。失败不抛错，只返回 false。
 */
export async function pingDb(): Promise<boolean> {
  try {
    const pool = getPgPool();
    await pool.query("SELECT 1");
    return true;
  } catch (exc) {
    logger.warning(`[pg] ping 失败: ${String(exc)}`);
    return false;
  }
}

/**
 * 确保 pgvector / pg_trgm 两个扩展已安装（幂等）。
 * 在建任何 agent 表之前调用一次即可。
 */
export async function ensureExtensions(): Promise<void> {
  const pool = getPgPool();
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
}

/**
 * 确保某 agent 的表存在；返回表名。
 *
 * 第一次调用会用 vector + text + jsonb 混合 schema 建表，并建好向量 / 关键字两类索引；
 * 已存在则什么都不做（幂等）。
 */
export async function ensureAgentTable(agentName: string): Promise<string> {
  const pool = getPgPool();
  const tableName = getTableName(agentName);

  // 向量维度由 embedding 模型决定，建表时必须先知道
  const dim = await getEmbedModelDim();

  // 表名只由受控 prefix + 固定 agent 名拼成，是合法标识符，可安全内插
  const createTableSql =
    `CREATE TABLE IF NOT EXISTS ${tableName} (` +
    `  id TEXT PRIMARY KEY,` +
    `  content TEXT NOT NULL,` +
    `  metadata JSONB,` +
    `  embedding vector(${dim})` +
    `)`;
  await pool.query(createTableSql);

  // 向量索引：HNSW + cosine，给 kNN 检索加速（数据量小时可有可无，留着更规范）
  const vectorIndexSql =
    `CREATE INDEX IF NOT EXISTS ${tableName}_embedding_idx ` +
    `ON ${tableName} USING hnsw (embedding vector_cosine_ops)`;
  await pool.query(vectorIndexSql);

  // 关键字索引：trigram GIN，给 word_similarity 关键字召回加速
  const trgmIndexSql =
    `CREATE INDEX IF NOT EXISTS ${tableName}_content_trgm_idx ` +
    `ON ${tableName} USING gin (content gin_trgm_ops)`;
  await pool.query(trgmIndexSql);

  return tableName;
}

/**
 * 返回某 agent 表当前的文档数。表不存在则返回 0。
 */
export async function countDocs(agentName: string): Promise<number> {
  const pool = getPgPool();
  const tableName = getTableName(agentName);

  const existsResult = await pool.query(
    "SELECT to_regclass($1) AS reg",
    [tableName],
  );
  const reg = existsResult.rows[0]?.reg;
  if (!reg) {
    return 0;
  }

  const countResult = await pool.query(`SELECT count(*)::int AS n FROM ${tableName}`);
  return countResult.rows[0]?.n ?? 0;
}

/**
 * 删掉某 agent 的整张表（重灌前用）。
 */
export async function deleteAgentTable(agentName: string): Promise<void> {
  const pool = getPgPool();
  const tableName = getTableName(agentName);
  await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
  logger.info(`[pg] 已删除表 ${tableName}`);
}
