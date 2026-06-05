/**
 * 用户表持久化（PostgreSQL）—— 登录鉴权用。
 *
 * 一张表（名字用 `<prefix>_user`，默认 `meetmind_user`）：
 *   user (id bigserial 主键自增, username text 唯一, password text, memory text)
 *
 * 四列对应：自增主键 id、用户名 username、用户密码 password、用户记忆 memory（先放着，后续扩展）。
 * 单机 demo：密码明文存储、明文比对，不做哈希（种子用户就是 admin/admin）。
 */

import { getSettings } from "../../config/settings.js";
import { getPgPool } from "../connection/client.js";

/** 登录校验结果。命中返回用户名，未命中只回 ok:false。 */
export interface LoginResult {
  ok: boolean;
  username?: string;
}

/** 注册结果。成功 ok:true;用户名已存在 ok:false + reason:"exists"。 */
export interface RegisterResult {
  ok: boolean;
  reason?: "exists";
}

/** user 表名。prefix 受控、是合法标识符，可安全内插。 */
function usersTable(): string {
  return `${getSettings().pgTablePrefix}_user`;
}

/** 建好 user 表（幂等）。bootstrap 里调一次。 */
export async function ensureUserTable(): Promise<void> {
  const pool = getPgPool();
  const users = usersTable();

  const createUsersSql =
    `CREATE TABLE IF NOT EXISTS ${users} (` +
    `  id BIGSERIAL PRIMARY KEY,` +
    `  username TEXT UNIQUE NOT NULL,` +
    `  password TEXT NOT NULL,` +
    `  memory TEXT` +
    `)`;
  await pool.query(createUsersSql);
}

/** 灌入种子用户 admin/admin（幂等：用户名已存在则跳过）。 */
export async function seedAdminUser(): Promise<void> {
  const pool = getPgPool();
  const users = usersTable();

  const insertSql =
    `INSERT INTO ${users} (username, password) VALUES ($1, $2) ` +
    `ON CONFLICT (username) DO NOTHING`;
  await pool.query(insertSql, ["admin", "admin"]);
}

/**
 * 注册新用户。用户名唯一(表上有 UNIQUE 约束),靠 ON CONFLICT DO NOTHING 原子判重:
 * 插入命中(返回了行)→ 新建成功 { ok:true };冲突被跳过(无返回行)→ 用户名已存在 { ok:false, reason:"exists" }。
 * 明文存密码,与 verifyUser 的明文比对保持一致(本地 demo)。
 */
export async function createUser(username: string, password: string): Promise<RegisterResult> {
  const pool = getPgPool();
  const users = usersTable();

  const insertSql =
    `INSERT INTO ${users} (username, password) VALUES ($1, $2) ` +
    `ON CONFLICT (username) DO NOTHING RETURNING id`;
  const result = await pool.query(insertSql, [username, password]);
  if (result.rows.length === 0) {
    return { ok: false, reason: "exists" };
  }
  return { ok: true };
}

/**
 * 校验用户名 / 密码。
 * 命中返回 { ok:true, username }，否则 { ok:false }。明文比对（本地 demo）。
 */
export async function verifyUser(username: string, password: string): Promise<LoginResult> {
  const pool = getPgPool();
  const users = usersTable();

  const selectSql = `SELECT username FROM ${users} WHERE username = $1 AND password = $2`;
  const result = await pool.query(selectSql, [username, password]);
  if (result.rows.length === 0) {
    return { ok: false };
  }
  const matchedName = result.rows[0].username;
  return { ok: true, username: matchedName };
}

/**
 * 读取某用户的 memory（个人记忆）。按 username 定位（与全局用户标识一致）。
 * 未命中该用户、或 memory 列为 NULL 都回空串，前端据此显示空文本框。
 */
export async function getMemory(username: string): Promise<string> {
  const pool = getPgPool();
  const users = usersTable();

  const selectSql = `SELECT memory FROM ${users} WHERE username = $1`;
  const result = await pool.query(selectSql, [username]);
  if (result.rows.length === 0) {
    return "";
  }
  const memory = result.rows[0].memory;
  return memory ?? "";
}

/**
 * 写入（整字段覆盖）某用户的 memory。空串合法，表示清空记忆。
 * 用户不存在时 UPDATE 不命中任何行，静默无操作（不报错）。
 */
export async function setMemory(username: string, memory: string): Promise<void> {
  const pool = getPgPool();
  const users = usersTable();

  const updateSql = `UPDATE ${users} SET memory = $2 WHERE username = $1`;
  await pool.query(updateSql, [username, memory]);
}
