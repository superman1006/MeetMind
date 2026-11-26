import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getSettings } from "../../config/settings.js";
import { getPgPool } from "../connection/client.js";
import * as chatStore from "./chatStore.js";

export interface TaskStep {
  agentName: string;
  instruction: string;
  displayName?: string;
}

export interface TaskPlan {
  title: string;
  steps: TaskStep[];
}

export type RoundMode = "direct" | "task" | "everyone";
type RoundStatus = "running" | "completed" | "interrupted" | "failed";

export interface Meeting {
  id: string;
  title: string;
  owner: string;
  participants: string[];
  created_at: Date;
  ended_at: Date | null;
  status: "in_progress" | "ended";
  archived_at: Date | null;
  pending_thread_id: string | null;
  minutes_status: "pending" | "writing" | "completed" | "failed" | null;
  minutes_filename: string | null;
}

// 一轮始于主持人发出的需求。分类结果、任务计划和已完成步数共同构成恢复现场。
export interface MeetingRound {
  id: string;
  session_id: string;
  requirement: string;
  created_at: Date;
  status: RoundStatus;
  mode: RoundMode | null;
  rewritten_query: string;
  expansion_terms: string;
  intent: string;
  plan: TaskPlan | null;
  completed_steps: number;
}

function tables() {
  const prefix = getSettings().pgTablePrefix;
  return {
    sessions: `${prefix}_sessions`,
    messages: `${prefix}_messages`,
    rounds: `${prefix}_meeting_rounds`,
    plans: `${prefix}_task_plans`,
  };
}

// 在已有会话和消息表上补充会议字段，轮次和任务计划分别存表。
export async function ensureMeetingTables(): Promise<void> {
  const t = tables();
  const pool = getPgPool();
  await pool.query(`ALTER TABLE ${t.sessions}
    ADD COLUMN IF NOT EXISTS participants TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS status TEXT CHECK (status IN ('in_progress', 'ended')),
    ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS minutes_status TEXT,
    ADD COLUMN IF NOT EXISTS minutes_filename TEXT`);
  await pool.query(`UPDATE ${t.sessions} SET status = CASE WHEN ended THEN 'ended' ELSE 'in_progress' END
    WHERE status IS NULL`);
  await pool.query(`ALTER TABLE ${t.sessions}
    ALTER COLUMN status SET DEFAULT 'in_progress', ALTER COLUMN status SET NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${t.sessions}_participants_idx ON ${t.sessions} USING GIN (participants)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${t.rounds} (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES ${t.sessions}(id) ON DELETE CASCADE,
    requirement TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'running', mode TEXT,
    rewritten_query TEXT NOT NULL DEFAULT '', expansion_terms TEXT NOT NULL DEFAULT '', intent TEXT NOT NULL DEFAULT ''
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${t.rounds}_session_idx ON ${t.rounds} (session_id, created_at)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${t.plans} (
    round_id TEXT PRIMARY KEY REFERENCES ${t.rounds}(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES ${t.sessions}(id) ON DELETE CASCADE,
    title TEXT NOT NULL, steps JSONB NOT NULL, completed_steps INTEGER NOT NULL DEFAULT 0
  )`);
  await pool.query(`ALTER TABLE ${t.messages}
    ADD COLUMN IF NOT EXISTS round_id TEXT REFERENCES ${t.rounds}(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS step INTEGER`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${t.messages}_round_step_idx ON ${t.messages} (round_id, step)`);
  // 重启时将遗留的 writing 纪要恢复为可领取的 pending。
  await pool.query(`UPDATE ${t.sessions} SET minutes_status='pending' WHERE minutes_status='writing'`);
}

export async function createMeeting(owner: string, title: string, participants: string[]): Promise<Meeting> {
  const t = tables();
  const result = await getPgPool().query<Meeting>(`INSERT INTO ${t.sessions} (id, owner, title, participants)
    VALUES ($1, $2, $3, $4) RETURNING *`, [randomUUID(), owner, title, participants]);
  return result.rows[0];
}

export async function getMeeting(sessionId: string, username: string): Promise<Meeting | undefined> {
  const t = tables();
  const result = await getPgPool().query<Meeting>(`SELECT * FROM ${t.sessions}
    WHERE id=$1 AND (owner=$2 OR participants @> ARRAY[$2]::text[])`, [sessionId, username]);
  return result.rows[0];
}

export async function listMeetings(username: string): Promise<Meeting[]> {
  const t = tables();
  const result = await getPgPool().query<Meeting>(`SELECT * FROM ${t.sessions}
    WHERE owner=$1 OR participants @> ARRAY[$1]::text[] ORDER BY created_at DESC`, [username]);
  return result.rows;
}

export async function setArchived(sessionId: string, archived: boolean): Promise<boolean> {
  const t = tables();
  const result = await getPgPool().query(`UPDATE ${t.sessions} SET archived_at = CASE WHEN $2::boolean THEN now() ELSE NULL END
    WHERE id=$1 AND pending_thread_id IS NULL`, [sessionId, archived]);
  return result.rowCount === 1;
}

// 锁住会话行，再登记在途标记、轮次和主持人消息。三个写入随同一事务提交。
export async function beginRound(meeting: Meeting, requirement: string, requestId?: string): Promise<string | null> {
  const t = tables();
  const roundId = requestId || randomUUID();
  const client = await getPgPool().connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query(`SELECT id FROM ${t.sessions} WHERE id=$1 FOR UPDATE`, [meeting.id]);
    if (lock.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    // 相同请求 ID、会议和需求可复用已有轮次，避免重试插入重复消息。
    const existing = await client.query(`SELECT id FROM ${t.rounds} WHERE id=$1 AND session_id=$2
      AND requirement=$3`, [roundId, meeting.id, requirement]);
    if (existing.rowCount) {
      await client.query("COMMIT");
      return roundId;
    }
    const claimed = await client.query(`UPDATE ${t.sessions} SET pending_thread_id=$2
      WHERE id=$1 AND status='in_progress' AND archived_at IS NULL AND pending_thread_id IS NULL`,
    [meeting.id, roundId]);
    if (claimed.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(`INSERT INTO ${t.rounds} (id, session_id, requirement) VALUES ($1, $2, $3)`,
      [roundId, meeting.id, requirement]);
    await insertRoundMessage(client, meeting.id, roundId, 0, "user", meeting.owner, requirement, []);
    await client.query("COMMIT");
    return roundId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// seq 用于会话内排序，round_id 与 step 用于去重。主持人消息占第 0 步。
async function insertRoundMessage(
  db: Pool | PoolClient, sessionId: string, roundId: string, step: number,
  agentName: string, displayName: string, text: string, tools: string[],
): Promise<void> {
  const t = tables();
  await db.query(`INSERT INTO ${t.messages}
    (session_id, seq, round_id, step, agent_name, role, message, used_rag, tool)
    SELECT $1, coalesce(max(seq), -1) + 1, $2, $3, $4, $5, $6, $7, $8
    FROM ${t.messages} WHERE session_id=$1
    ON CONFLICT (round_id, step) DO NOTHING`,
  [sessionId, roundId, step, agentName, displayName, text, tools.includes("rag_search"), tools.join(", ")]);
}

const ROUND_SELECT = "r.*, CASE WHEN p.round_id IS NULL THEN NULL ELSE jsonb_build_object('title',p.title,'steps',p.steps) END AS plan, coalesce(p.completed_steps, 0)::int AS completed_steps";

export async function getRound(roundId: string): Promise<MeetingRound | undefined> {
  const t = tables();
  const result = await getPgPool().query<MeetingRound>(`SELECT ${ROUND_SELECT}
    FROM ${t.rounds} r LEFT JOIN ${t.plans} p ON p.round_id=r.id WHERE r.id=$1`, [roundId]);
  return result.rows[0];
}

export async function listRounds(sessionId: string): Promise<MeetingRound[]> {
  const t = tables();
  const result = await getPgPool().query<MeetingRound>(`SELECT ${ROUND_SELECT}
    FROM ${t.rounds} r LEFT JOIN ${t.plans} p ON p.round_id=r.id
    WHERE r.session_id=$1 ORDER BY r.created_at DESC, r.id`, [sessionId]);
  return result.rows;
}

// 持久化分类及改写产物，恢复时可以复用同一轮的预处理结果。
export async function saveBoundary(
  roundId: string, mode: RoundMode, rewrittenQuery: string, expansionTerms: string, intent: string,
): Promise<void> {
  const t = tables();
  await getPgPool().query(`UPDATE ${t.rounds} SET mode=$2, rewritten_query=$3, expansion_terms=$4, intent=$5
    WHERE id=$1`, [roundId, mode, rewrittenQuery, expansionTerms, intent]);
}

export async function savePlan(round: MeetingRound, plan: TaskPlan): Promise<void> {
  const t = tables();
  const stepsJson = JSON.stringify(plan.steps);
  await getPgPool().query(`INSERT INTO ${t.plans} (round_id, session_id, title, steps)
    VALUES ($1,$2,$3,$4) ON CONFLICT (round_id) DO NOTHING`, [round.id, round.session_id, plan.title, stepsJson]);
}

// 在同一事务提交数字人回复和计划进度，恢复时两者可以对齐。
export async function saveReply(
  round: MeetingRound, step: number, agentName: string, displayName: string, reply: string, tools: string[],
): Promise<void> {
  const t = tables();
  const client = await getPgPool().connect();
  try {
    await client.query("BEGIN");
    await insertRoundMessage(client, round.session_id, round.id, step + 1, agentName, displayName, reply, tools);
    await client.query(`UPDATE ${t.plans} SET completed_steps = GREATEST(completed_steps, $2) WHERE round_id=$1`,
      [round.id, step + 1]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function hasDirectReply(roundId: string): Promise<boolean> {
  const t = tables();
  const result = await getPgPool().query(`SELECT 1 FROM ${t.messages} WHERE round_id=$1 AND step=1`, [roundId]);
  return result.rowCount === 1;
}

// 仅在会话仍指向这一轮时清除在途标记并更新轮次终态。
export async function finishRound(round: MeetingRound, status: Exclude<RoundStatus, "running">): Promise<void> {
  const t = tables();
  await getPgPool().query(`WITH cleared AS (
    UPDATE ${t.sessions} SET pending_thread_id=NULL WHERE id=$3 AND pending_thread_id=$1 RETURNING id
  )
    UPDATE ${t.rounds} SET status=$2 FROM cleared
    WHERE ${t.rounds}.id=$1 AND ${t.rounds}.session_id=cleared.id`, [round.id, status, round.session_id]);
}

export async function endMeeting(sessionId: string): Promise<Meeting | undefined> {
  const t = tables();
  const result = await getPgPool().query<Meeting>(`UPDATE ${t.sessions} SET status='ended', ended=true,
    ended_at=now(), minutes_status='pending'
    WHERE id=$1 AND status='in_progress' AND archived_at IS NULL AND pending_thread_id IS NULL RETURNING *`, [sessionId]);
  return result.rows[0];
}

// 用带状态条件的 UPDATE 领取纪要任务。并发请求只有一个能取得待写记录。
export async function claimMinutes(sessionId: string): Promise<Meeting | undefined> {
  const t = tables();
  const result = await getPgPool().query<Meeting>(`UPDATE ${t.sessions} SET minutes_status='writing'
    WHERE id=$1 AND minutes_status IN ('pending','failed') RETURNING *`, [sessionId]);
  return result.rows[0];
}

export async function setMinutesResult(sessionId: string, filename: string | null): Promise<void> {
  const t = tables();
  const status = filename ? "completed" : "failed";
  await getPgPool().query(`UPDATE ${t.sessions} SET minutes_status=$2, minutes_filename=$3 WHERE id=$1`,
    [sessionId, status, filename]);
}

export async function getMeetingHistory(sessionId: string) {
  const messages = await chatStore.getMessages(sessionId);
  for (const message of messages) {
    // 会议只共享生成的回复和工具名称。
    delete message.tool_calls;
  }
  return messages;
}
