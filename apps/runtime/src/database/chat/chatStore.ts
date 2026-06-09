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
  // 获取数据库连接池
  const pool = getPgPool();
  const sessions = sessionsTable();
  const messages = messagesTable();

  // 创建 sessions 表
  const createSessionsSql =
    `CREATE TABLE IF NOT EXISTS ${sessions} (` +
    `  id TEXT PRIMARY KEY,` +
    `  title TEXT NOT NULL,` +
    `  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),` +
    `  ended BOOLEAN NOT NULL DEFAULT false,` +
    `  owner TEXT NOT NULL` +
    `)`;
  // 执行创建 sessions 表的 SQL 语句
  await pool.query(createSessionsSql);

  // 添加 ended 列
  await pool.query(`ALTER TABLE ${sessions} ADD COLUMN IF NOT EXISTS ended BOOLEAN NOT NULL DEFAULT false`);

  // 添加 owner 列
  await pool.query(`ALTER TABLE ${sessions} ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'admin'`);
  await pool.query(`ALTER TABLE ${sessions} ALTER COLUMN owner DROP DEFAULT`);

  // 断点续跑：本会话当前在途轮次的 LangGraph thread_id（非空=有未收尾的轮，可恢复）。
  await pool.query(`ALTER TABLE ${sessions} ADD COLUMN IF NOT EXISTS pending_thread_id TEXT`);

  // 上下文压缩（A 方案）：在 sessions 行上记一份「滚动摘要」+「已折进摘要的最大 seq（=压缩边界）」。
  // 压缩只 UPDATE 这两列、不动 messages 表：messages 仍存全量供前端展示，喂 LLM 时改走「摘要 + 边界后尾部」。
  // summary 默认空串 / 边界默认 -1（= 还没压过，等价于「全部消息都在边界之后」）。
  await pool.query(`ALTER TABLE ${sessions} ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE ${sessions} ADD COLUMN IF NOT EXISTS summarized_through_seq INT NOT NULL DEFAULT -1`);

  // 列表按 owner 过滤,给 owner 建索引
  const ownerIndexSql =
    `CREATE INDEX IF NOT EXISTS ${sessions}_owner_idx ` +
    `ON ${sessions} (owner)`;
  // 执行添加 owner 索引的 SQL 语句
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
  // 执行创建 messages 表的 SQL 语句
  await pool.query(createMessagesSql);

  // 添加 tool 列
  await pool.query(`ALTER TABLE ${messages} ADD COLUMN IF NOT EXISTS tool TEXT NOT NULL DEFAULT ''`);
  // 添加 tool_calls 列
  await pool.query(`ALTER TABLE ${messages} ADD COLUMN IF NOT EXISTS tool_calls JSONB NOT NULL DEFAULT '[]'`);

  // 创建 (session_id, seq) 联合索引
  const indexSql =
    `CREATE INDEX IF NOT EXISTS ${messages}_session_seq_idx ` +
    `ON ${messages} (session_id, seq)`;
  // 执行创建联合索引的 SQL 语句
  await pool.query(indexSql);
}

/** 新建一个会话(归属 owner 用户名)，返回其元信息。 */
export async function createSession(title: string, owner: string): Promise<SessionMeta> {
  const pool = getPgPool();
  const id = randomUUID();
  // 插入会话元信息
  const insertSql =
    `INSERT INTO ${sessionsTable()} (id, title, owner) VALUES ($1, $2, $3) ` +
    `RETURNING id, title, created_at`;
  // 执行插入会话元信息的 SQL 语句
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
  // 执行查询会话元信息的 SQL 语句
  const result = await pool.query(selectSql, [owner]);
  const metas: SessionMeta[] = [];
  for (const row of result.rows) {
    // 将 ended 转换为 boolean 类型
    metas.push({ id: row.id, title: row.title, created_at: String(row.created_at), ended: row.ended === true });
  }
  return metas;
}

/** 取某会话的归属用户名(owner)。未知会话返回空串。用于按会话主人加载其个人记忆。 */
export async function getSessionOwner(sessionId: string): Promise<string> {
  const pool = getPgPool();
  const selectSql = `SELECT owner FROM ${sessionsTable()} WHERE id = $1`;
  // 执行查询会话归属用户名的 SQL 语句
  const result = await pool.query(selectSql, [sessionId]);
  if (result.rows.length === 0) {
    return "";
  }
  return result.rows[0].owner ?? "";
}

/** 把一行 messages 记录映射成 AgentResponse（getMessages / getMessagesAfterSeq 共用）。 */
function mapRowToResponse(row: Record<string, unknown>): AgentResponse {
  // tool_calls 列是 jsonb，pg 驱动已自动 parse 成数组；旧行/空值兜底为空数组
  const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
  return {
    agent_name: row.agent_name as string,
    role: row.role as string,
    message: row.message as string,
    next_agent: (row.next_agent as string | null) ?? null,
    done: row.done as boolean,
    used_rag: row.used_rag as boolean,
    tool: (row.tool as string) ?? "",
    tool_calls: toolCalls,
    created_at: String(row.created_at),
  };
}

/** 取某会话中 seq 大于 afterSeq 的消息，按 seq 升序。afterSeq=-1 即全部。 */
export async function getMessagesAfterSeq(sessionId: string, afterSeq: number): Promise<AgentResponse[]> {
  const pool = getPgPool();
  const selectSql =
    `SELECT agent_name, role, message, next_agent, done, used_rag, tool, tool_calls, created_at ` +
    `FROM ${messagesTable()} WHERE session_id = $1 AND seq > $2 ORDER BY seq ASC`;
  const result = await pool.query(selectSql, [sessionId, afterSeq]);
  const turns: AgentResponse[] = [];
  for (const row of result.rows) {
    turns.push(mapRowToResponse(row));
  }
  return turns;
}

/** 取某会话的全部消息，按 seq 升序。未知会话返回空数组。前端展示历史走这条（永远全量，不受压缩影响）。 */
export async function getMessages(sessionId: string): Promise<AgentResponse[]> {
  return getMessagesAfterSeq(sessionId, -1);
}

/** 合成摘要 turn 的 agent_name / role（formatHistory 会渲染成 "--- system (历史摘要) ---"）。 */
const SUMMARY_AGENT_NAME = "system";
const SUMMARY_ROLE = "历史摘要";

/** 某会话当前的压缩状态：滚动摘要文本 + 已折进摘要的最大 seq（边界）。未压过 → {summary:"", throughSeq:-1}。 */
export async function getCompactionState(sessionId: string): Promise<{ summary: string; throughSeq: number }> {
  const pool = getPgPool();
  const selectSql = `SELECT summary, summarized_through_seq FROM ${sessionsTable()} WHERE id = $1`;
  const result = await pool.query(selectSql, [sessionId]);
  const row = result.rows[0];
  if (!row) {
    return { summary: "", throughSeq: -1 };
  }
  return { summary: row.summary ?? "", throughSeq: row.summarized_through_seq ?? -1 };
}

/** 写入/更新某会话的压缩状态：摘要文本 + 新边界 seq。压缩动作只 UPDATE 这两列，messages 表一行不动。 */
export async function setCompaction(sessionId: string, summary: string, throughSeq: number): Promise<void> {
  const pool = getPgPool();
  const updateSql =
    `UPDATE ${sessionsTable()} SET summary = $2, summarized_through_seq = $3 WHERE id = $1`;
  await pool.query(updateSql, [sessionId, summary, throughSeq]);
}

/** 取某会话当前最大 seq（空会话返回 -1）。压缩时用来定边界、判断有没有新消息可压。 */
export async function getMaxSeq(sessionId: string): Promise<number> {
  const pool = getPgPool();
  const maxSql = `SELECT coalesce(max(seq), -1) AS max_seq FROM ${messagesTable()} WHERE session_id = $1`;
  const result = await pool.query(maxSql, [sessionId]);
  return result.rows[0]?.max_seq ?? -1;
}

/**
 * 取「喂给 LLM 的上下文消息」：摘要(合成一条) + 边界之后的尾部消息。
 * 还没压缩过(summary 为空)时退化为全量 getMessages，与压缩前行为一致。
 * 注意：这条只供 runExecution 拼 LLM 历史用；前端展示历史仍走 getMessages（全量）。
 */
export async function getContextMessages(sessionId: string): Promise<AgentResponse[]> {
  const state = await getCompactionState(sessionId);
  const tail = await getMessagesAfterSeq(sessionId, state.throughSeq);
  if (!state.summary) {
    return tail;
  }
  const summaryTurn: AgentResponse = {
    agent_name: SUMMARY_AGENT_NAME,
    role: SUMMARY_ROLE,
    message: `【以下是更早讨论的压缩摘要，请据此理解上文】\n${state.summary}`,
    next_agent: null,
    done: false,
    used_rag: false,
  };
  return [summaryTurn, ...tail];
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
    // 将 tool_calls 列是 jsonb，pg 驱动已自动 parse 成数组；旧行/空值兜底为空数组
    const toolCallsJson = JSON.stringify(turn.tool_calls ?? []);
    // 执行插入消息的 SQL 语句
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
  // 执行重命名会话的 SQL 语句
  await pool.query(updateSql, [sessionId, title]);
}

/** 把某会话标记为已结束(点「结束」后持久化;此后服务端拒绝再发送/再结束)。未知 id 影响 0 行。 */
export async function markSessionEnded(sessionId: string): Promise<void> {
  const pool = getPgPool();
  const updateSql = `UPDATE ${sessionsTable()} SET ended = true WHERE id = $1`;
  // 执行标记会话为已结束的 SQL 语句
  await pool.query(updateSql, [sessionId]);
}

/** 查某会话是否已结束。未知 id(无此行)按未结束处理,返回 false。 */
export async function isSessionEnded(sessionId: string): Promise<boolean> {
  const pool = getPgPool();
  const selectSql = `SELECT ended FROM ${sessionsTable()} WHERE id = $1`;
  // 执行查询会话是否已结束的 SQL 语句
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
  // 执行删除会话的 SQL 语句
  await pool.query(deleteSql, [sessionId]);
}

/** 记下本会话当前在途轮次的 thread_id（轮开始时写）。 */
export async function setPendingThread(sessionId: string, threadId: string): Promise<void> {
  const pool = getPgPool();
  const updateSql = `UPDATE ${sessionsTable()} SET pending_thread_id = $2 WHERE id = $1`;
  await pool.query(updateSql, [sessionId, threadId]);
}

/** 清除本会话的在途标记（正常完成 / 用户停止时调）。 */
export async function clearPendingThread(sessionId: string): Promise<void> {
  const pool = getPgPool();
  const updateSql = `UPDATE ${sessionsTable()} SET pending_thread_id = NULL WHERE id = $1`;
  await pool.query(updateSql, [sessionId]);
}

/** 取本会话在途轮次的 thread_id；无 / 为 NULL 时回 null。 */
export async function getPendingThread(sessionId: string): Promise<string | null> {
  const pool = getPgPool();
  const selectSql = `SELECT pending_thread_id FROM ${sessionsTable()} WHERE id = $1`;
  const result = await pool.query(selectSql, [sessionId]);
  const row = result.rows[0];
  if (!row || !row.pending_thread_id) {
    return null;
  }
  return row.pending_thread_id;
}
