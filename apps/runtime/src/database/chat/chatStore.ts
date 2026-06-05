/**
 * 会话 / 消息持久化（PostgreSQL）。
 *
 * 两张表（建在与 agent 表同一个 pool 上，名字用 `<prefix>_sessions` / `<prefix>_messages`）：
 *   sessions (id text 主键, title text, created_at timestamptz, ended boolean, owner text=归属用户名)
 *   messages (id bigserial 主键, session_id text → sessions(id) ON DELETE CASCADE,
 *             seq int, 以及一条 AgentResponse 的六字段)
 *
 * 一条 messages 行 = 一条 AgentResponse。删 session 行时 messages 靠外键级联自动删除。
 * 按 owner（用户名）隔离：每个会话挂在创建它的用户名下，listSessions 只返回该用户自己的会话。
 * session id 在 Node 里用 crypto.randomUUID() 生成，免装 uuid 相关扩展。
 */

import { randomUUID } from "node:crypto";

import { getSettings } from "../../config/settings.js";
import type { AgentResponse } from "../../agents/base.js";
import { getPgPool } from "../connection/client.js";

/** 会话元信息（列表用）。 */
export interface SessionMeta {
  id: string;
  title: string;
  created_at: string;
  ended: boolean;
}

/** sessions 表名。prefix 受控、是合法标识符，可安全内插。 */
function sessionsTable(): string {
  return `${getSettings().pgTablePrefix}_sessions`;
}

/** messages 表名。 */
function messagesTable(): string {
  return `${getSettings().pgTablePrefix}_messages`;
}

/** 建好 sessions / messages 两张表（幂等）。bootstrap 里调一次。 */
export async function ensureChatTables(): Promise<void> {
  const pool = getPgPool();
  const sessions = sessionsTable();
  const messages = messagesTable();

  const createSessionsSql =
    `CREATE TABLE IF NOT EXISTS ${sessions} (` +
    `  id TEXT PRIMARY KEY,` +
    `  title TEXT NOT NULL,` +
    `  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),` +
    `  ended BOOLEAN NOT NULL DEFAULT false,` +
    `  owner TEXT NOT NULL` +
    `)`;
  await pool.query(createSessionsSql);

  // 兼容旧表:ended 列可能不存在,补上(幂等)
  await pool.query(`ALTER TABLE ${sessions} ADD COLUMN IF NOT EXISTS ended BOOLEAN NOT NULL DEFAULT false`);

  // 兼容旧表:owner 列(会话归属用户名)可能不存在。先带 DEFAULT 'admin' 补列——把历史无主会话回填给种子用户 admin;
  // 再 DROP DEFAULT,使此后新建会话必须显式带 owner(漏传直接报错,而不是静默落到 admin)。新库这两步是 no-op。
  await pool.query(`ALTER TABLE ${sessions} ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'admin'`);
  await pool.query(`ALTER TABLE ${sessions} ALTER COLUMN owner DROP DEFAULT`);

  // 列表按 owner 过滤,给 owner 建索引
  const ownerIndexSql =
    `CREATE INDEX IF NOT EXISTS ${sessions}_owner_idx ` +
    `ON ${sessions} (owner)`;
  await pool.query(ownerIndexSql);

  const createMessagesSql =
    `CREATE TABLE IF NOT EXISTS ${messages} (` +
    `  id BIGSERIAL PRIMARY KEY,` +
    `  session_id TEXT NOT NULL REFERENCES ${sessions}(id) ON DELETE CASCADE,` +
    `  seq INT NOT NULL,` +
    `  agent_name TEXT NOT NULL,` +
    `  role TEXT NOT NULL,` +
    `  message TEXT NOT NULL,` +
    `  next_agent TEXT,` +
    `  done BOOLEAN NOT NULL DEFAULT false,` +
    `  used_rag BOOLEAN NOT NULL DEFAULT false,` +
    `  tool TEXT NOT NULL DEFAULT '',` +
    `  tool_calls JSONB NOT NULL DEFAULT '[]',` +
    `  created_at TIMESTAMPTZ NOT NULL DEFAULT now()` +
    `)`;
  await pool.query(createMessagesSql);

  // 兼容旧表:tool 列可能不存在,补上(幂等)
  await pool.query(`ALTER TABLE ${messages} ADD COLUMN IF NOT EXISTS tool TEXT NOT NULL DEFAULT ''`);
  // 兼容旧表:tool_calls 列(每次工具调用的 name/args/result 明细)可能不存在,补上(幂等)
  await pool.query(`ALTER TABLE ${messages} ADD COLUMN IF NOT EXISTS tool_calls JSONB NOT NULL DEFAULT '[]'`);

  // 按会话取历史时按 (session_id, seq) 排序，建个联合索引
  const indexSql =
    `CREATE INDEX IF NOT EXISTS ${messages}_session_seq_idx ` +
    `ON ${messages} (session_id, seq)`;
  await pool.query(indexSql);
}

/** 新建一个会话(归属 owner 用户名)，返回其元信息。 */
export async function createSession(title: string, owner: string): Promise<SessionMeta> {
  const pool = getPgPool();
  const id = randomUUID();
  const insertSql =
    `INSERT INTO ${sessionsTable()} (id, title, owner) VALUES ($1, $2, $3) ` +
    `RETURNING id, title, created_at`;
  const result = await pool.query(insertSql, [id, title, owner]);
  const row = result.rows[0];
  // 新建会话必然未结束,ended 直接 false(DB 默认值也是 false)。
  return { id: row.id, title: row.title, created_at: String(row.created_at), ended: false };
}

/** 列出某用户(owner)自己的会话，最近创建的在前。 */
export async function listSessions(owner: string): Promise<SessionMeta[]> {
  const pool = getPgPool();
  const selectSql =
    `SELECT id, title, created_at, ended FROM ${sessionsTable()} ` +
    `WHERE owner = $1 ORDER BY created_at DESC`;
  const result = await pool.query(selectSql, [owner]);
  const metas: SessionMeta[] = [];
  for (const row of result.rows) {
    metas.push({ id: row.id, title: row.title, created_at: String(row.created_at), ended: row.ended === true });
  }
  return metas;
}

/** 取某会话的归属用户名(owner)。未知会话返回空串。用于按会话主人加载其个人记忆。 */
export async function getSessionOwner(sessionId: string): Promise<string> {
  const pool = getPgPool();
  const selectSql = `SELECT owner FROM ${sessionsTable()} WHERE id = $1`;
  const result = await pool.query(selectSql, [sessionId]);
  if (result.rows.length === 0) {
    return "";
  }
  return result.rows[0].owner ?? "";
}

/** 取某会话的全部消息，按 seq 升序。未知会话返回空数组。 */
export async function getMessages(sessionId: string): Promise<AgentResponse[]> {
  const pool = getPgPool();
  const selectSql =
    `SELECT agent_name, role, message, next_agent, done, used_rag, tool, tool_calls, created_at ` +
    `FROM ${messagesTable()} WHERE session_id = $1 ORDER BY seq ASC`;
  const result = await pool.query(selectSql, [sessionId]);
  const turns: AgentResponse[] = [];
  for (const row of result.rows) {
    // tool_calls 列是 jsonb，pg 驱动已自动 parse 成数组；旧行/空值兜底为空数组
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    turns.push({
      agent_name: row.agent_name,
      role: row.role,
      message: row.message,
      next_agent: row.next_agent,
      done: row.done,
      used_rag: row.used_rag,
      tool: row.tool ?? "",
      tool_calls: toolCalls,
      created_at: String(row.created_at),
    });
  }
  return turns;
}

/** 把本轮新增的若干 turn 追加进某会话，seq 接着已有最大值往后排。 */
export async function appendMessages(
  sessionId: string,
  turns: AgentResponse[],
): Promise<void> {
  if (turns.length === 0) {
    return;
  }
  const pool = getPgPool();
  const messages = messagesTable();

  // 先拿当前最大 seq（空会话为 -1，下一条从 0 开始）
  const maxSql = `SELECT coalesce(max(seq), -1) AS max_seq FROM ${messages} WHERE session_id = $1`;
  const maxResult = await pool.query(maxSql, [sessionId]);
  let nextSeq = (maxResult.rows[0]?.max_seq ?? -1) + 1;

  const insertSql =
    `INSERT INTO ${messages} ` +
    `(session_id, seq, agent_name, role, message, next_agent, done, used_rag, tool, tool_calls) ` +
    `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
  for (const turn of turns) {
    // tool_calls 走 jsonb，参数传 JSON 字符串(pg 会按列类型转成 jsonb)；缺省为空数组
    const toolCallsJson = JSON.stringify(turn.tool_calls ?? []);
    await pool.query(insertSql, [
      sessionId,
      nextSeq,
      turn.agent_name,
      turn.role,
      turn.message,
      turn.next_agent,
      turn.done,
      turn.used_rag,
      turn.tool ?? "",
      toolCallsJson,
    ]);
    nextSeq += 1;
  }
}

/** 重命名某会话(只改 title)。未知 id 时不报错(影响 0 行)。 */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  const pool = getPgPool();
  const updateSql = `UPDATE ${sessionsTable()} SET title = $2 WHERE id = $1`;
  await pool.query(updateSql, [sessionId, title]);
}

/** 把某会话标记为已结束(点「结束」后持久化;此后服务端拒绝再发送/再结束)。未知 id 影响 0 行。 */
export async function markSessionEnded(sessionId: string): Promise<void> {
  const pool = getPgPool();
  const updateSql = `UPDATE ${sessionsTable()} SET ended = true WHERE id = $1`;
  await pool.query(updateSql, [sessionId]);
}

/** 查某会话是否已结束。未知 id(无此行)按未结束处理,返回 false。 */
export async function isSessionEnded(sessionId: string): Promise<boolean> {
  const pool = getPgPool();
  const selectSql = `SELECT ended FROM ${sessionsTable()} WHERE id = $1`;
  const result = await pool.query(selectSql, [sessionId]);
  const row = result.rows[0];
  if (!row) {
    return false;
  }
  return row.ended === true;
}

/** 删除某会话；它的 messages 靠外键 ON DELETE CASCADE 一并删除。 */
export async function deleteSession(sessionId: string): Promise<void> {
  const pool = getPgPool();
  const deleteSql = `DELETE FROM ${sessionsTable()} WHERE id = $1`;
  await pool.query(deleteSql, [sessionId]);
}
