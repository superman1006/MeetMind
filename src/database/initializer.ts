/**
 * 用种子文档初始化每个 agent 的 ES index。
 *
 * 种子目录结构：
 *     data/seed/
 *         architect/
 *             seeds.json
 *             roadmap.pdf
 *         backend/
 *             seeds.json
 *         ...
 *
 * 每个文件按扩展名走 loaders.ts，再过 splitters.splitDocs 按类型切块，
 * 然后批量算向量、写入 PostgreSQL。doc_id 基于内容 md5 + ON CONFLICT 保证幂等。
 */

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { AGENT_NAMES } from "../config/constants.js";
import { getSettings } from "../config/settings.js";
import { getLogger } from "../utils/logger.js";
import {
  deleteAgentTable,
  ensureAgentTable,
  ensureExtensions,
  getPgPool,
} from "./client.js";
import { embedBatch } from "./embedding.js";
import { loadFile, type RawDoc } from "./loaders.js";
import { splitDocs } from "./splitters.js";

const logger = getLogger("database.initializer");

function agentSeedDir(agentName: string): string {
  return path.join(getSettings().seedDataPath, agentName);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 扫描 agent 子目录下所有受支持的文件，返回合并后的 RawDoc 列表。
 * 若目录不存在，回退到旧布局 `data/seed/<agent>_seeds.json`。
 */
async function getSeedsContent(agentName: string): Promise<RawDoc[]> {
  const dir = agentSeedDir(agentName);
  if (!(await pathExists(dir))) {
    const legacy = path.join(getSettings().seedDataPath, `${agentName}_seeds.json`);
    if (await pathExists(legacy)) {
      return loadFile(legacy);
    }
    logger.warning(`没有 ${agentName} 的种子目录或旧种子文件`);
    return [];
  }

  const entries = await readdir(dir);
  entries.sort();
  const docs: RawDoc[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, name);
    const s = await stat(full);
    if (!s.isFile()) {
      continue;
    }
    const loaded = await loadFile(full);
    if (loaded.length > 0) {
      logger.info(`[${agentName}] 从 ${name} 加载了 ${loaded.length} 段`);
    }
    docs.push(...loaded);
  }
  return docs;
}

/**
 * 基于内容 hash 生成稳定的 doc_id —— 同内容只灌一次，幂等。
 */
function generateDocId(agentName: string, content: string): string {
  // 内容 md5 当 id，同内容只灌一次
  const digest = createHash("md5").update(content, "utf-8").digest("hex").slice(0, 12);
  return `${agentName}_${digest}`;
}

/**
 * 读出某张表内所有现有 doc id（种子集合通常很小，全量拉回即可）。
 * 调用前必须已 ensureAgentTable，故表一定存在。
 */
async function getExistingIds(tableName: string): Promise<Set<string>> {
  const pool = getPgPool();
  const resp = await pool.query(`SELECT id FROM ${tableName}`);
  const out = new Set<string>();
  for (const row of resp.rows) {
    if (typeof row.id === "string") {
      out.add(row.id);
    }
  }
  return out;
}

interface SeedRow {
  id: string;
  content: string;
  metadata: { type: unknown; date: unknown; source: unknown };
  embedding: number[];
}

/**
 * 把 number[] 向量转成 pgvector 文本字面量 `[v1,v2,...]`，供 `$n::vector` 插入用。
 */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * 把单个 agent 子目录下的所有种子文件灌入它的 PostgreSQL 表。返回本次新增条数。
 */
export async function loadSeedsToPg(agentName: string): Promise<number> {
  const seedContents = await getSeedsContent(agentName);
  if (seedContents.length === 0) {
    return 0;
  }

  const seedChunks = await splitDocs(seedContents);
  const tableName = await ensureAgentTable(agentName);
  const existingIds = await getExistingIds(tableName);

  const newIds: string[] = [];
  const newContents: string[] = [];
  const newMetadatas: SeedRow["metadata"][] = [];

  for (const chunk of seedChunks) {
    const content = (typeof chunk.content === "string" ? chunk.content : "").trim();
    if (!content) {
      continue;
    }
    const docId = generateDocId(agentName, content);
    if (existingIds.has(docId)) {
      continue; // 已灌过，跳过实现幂等（DB 侧还有 ON CONFLICT 兜底）
    }
    newIds.push(docId);
    newContents.push(content);
    newMetadatas.push({
      type: chunk.type,
      date: chunk.date,
      source: chunk.source,
    });
  }

  if (newIds.length === 0) {
    logger.info(`${agentName} 已是最新（共 ${existingIds.size} 条）`);
    return 0;
  }

  const vectors = await embedBatch(newContents); // 批量算向量再写库

  // 拼一条多行 INSERT：每行 4 个占位符（id, content, metadata, embedding）
  const valuePlaceholders: string[] = [];
  const params: unknown[] = [];
  let p = 0;
  for (let i = 0; i < newIds.length; i++) {
    const idPos = ++p;
    const contentPos = ++p;
    const metaPos = ++p;
    const embPos = ++p;
    valuePlaceholders.push(`($${idPos}, $${contentPos}, $${metaPos}::jsonb, $${embPos}::vector)`);
    params.push(newIds[i]);
    params.push(newContents[i]);
    params.push(JSON.stringify(newMetadatas[i]));
    params.push(toVectorLiteral(vectors[i]));
  }

  const insertSql =
    `INSERT INTO ${tableName} (id, content, metadata, embedding) ` +
    `VALUES ${valuePlaceholders.join(", ")} ` +
    `ON CONFLICT (id) DO NOTHING`;

  const pool = getPgPool();
  const result = await pool.query(insertSql, params);
  const success = result.rowCount ?? 0;
  logger.info(`已为 ${agentName} 新增 ${success} 条文档`);
  return success;
}

/**
 * 为所有 agent 灌入种子数据。返回每个 agent 本次新增的文档数。
 * 灌库前先确保 pgvector / pg_trgm 扩展就位。
 */
export async function buildAgentsIndices(): Promise<Record<string, number>> {
  await ensureExtensions();
  const results: Record<string, number> = {};
  for (const agent of AGENT_NAMES) {
    results[agent] = await loadSeedsToPg(agent);
  }
  return results;
}

/**
 * 清空并重新灌入单个 agent 的表（开发者工具）。
 */
export async function resetAgentDb(agentName: string): Promise<void> {
  await ensureExtensions();
  await deleteAgentTable(agentName);
  await loadSeedsToPg(agentName);
}
