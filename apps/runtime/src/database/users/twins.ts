import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { AGENT_NAMES, ROLE_DESCRIPTIONS } from "../../config/constants.js";
import { getSettings } from "../../config/settings.js";
import { ensureAgentTable, getPgPool } from "../connection/client.js";

const deriveKey = promisify(scrypt);
export const LOGIN_SECONDS = 7 * 24 * 60 * 60;

// username 用于登录与参会，agent_key 用于图节点和私有知识表。
export interface Twin {
  username: string;
  agent_key: string;
  display_name: string;
  is_seed: boolean;
  persona: string;
  memory: string;
  tools: string[];
  skills: string[];
}

export type TwinProfile = Pick<Twin, "display_name" | "persona" | "memory" | "tools" | "skills">;

const SEED_TOOLS = JSON.stringify(["rag_search", "Read", "list_dir", "glob", "grep"]);
const TWIN_COLUMNS = "username, agent_key, display_name, is_seed, persona, coalesce(memory,'') AS memory, tools, skills";

function usersTable(): string {
  return `${getSettings().pgTablePrefix}_user`;
}

function authTable(): string {
  return `${getSettings().pgTablePrefix}_auth_sessions`;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}

async function matchesPassword(password: string, hash: string): Promise<boolean> {
  const [algorithm, salt, digest] = hash.split(":");
  if (algorithm !== "scrypt" || !salt || !digest) return false;
  const expected = Buffer.from(digest, "hex");
  const actual = await deriveKey(password, salt, 64) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// 在原用户表上补齐数字人字段，初始化登录会话表并登记内置角色。
export async function ensureTwinTables(): Promise<void> {
  const pool = getPgPool();
  const table = usersTable();
  await pool.query(`ALTER TABLE ${table}
    ADD COLUMN IF NOT EXISTS agent_key TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS persona TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS tools JSONB NOT NULL DEFAULT '["rag_search"]',
    ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS is_seed BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`UPDATE ${table} SET agent_key = 'u' || id, display_name = username WHERE agent_key IS NULL`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${authTable()} (
    token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES ${table}(username) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await pool.query(`DELETE FROM ${authTable()} WHERE expires_at <= now()`);

  const oldPasswords = await pool.query(`SELECT username, password FROM ${table}
    WHERE password <> '' AND password NOT LIKE 'scrypt:%'`);
  for (const row of oldPasswords.rows) {
    const passwordHash = await hashPassword(row.password);
    await pool.query(`UPDATE ${table} SET password = $2 WHERE username = $1`, [row.username, passwordHash]);
  }
  if (process.env.MEETMIND_ADMIN_PASSWORD) {
    const admin = await pool.query(`SELECT password FROM ${table} WHERE username='admin'`);
    if (!await matchesPassword(process.env.MEETMIND_ADMIN_PASSWORD, admin.rows[0].password)) {
      const passwordHash = await hashPassword(process.env.MEETMIND_ADMIN_PASSWORD);
      await pool.query(`UPDATE ${table} SET password = $1 WHERE username = 'admin'`, [passwordHash]);
      await pool.query(`DELETE FROM ${authTable()} WHERE username='admin'`);
    }
  }

  for (const name of AGENT_NAMES) {
    const password = process.env[`MEETMIND_${name.toUpperCase()}_PASSWORD`];
    const result = await pool.query(`SELECT is_seed, password FROM ${table} WHERE username = $1`, [name]);
    const row = result.rows[0];
    if (row && !row.is_seed) {
      throw new Error(`内置角色账号 ${name} 与已有用户重名，请先处理账号冲突`);
    }
    let passwordHash = "";
    if (password) {
      const alreadyConfigured = row && await matchesPassword(password, row.password);
      passwordHash = alreadyConfigured ? row.password : await hashPassword(password);
    }
    await pool.query(`INSERT INTO ${table} (username, password, agent_key, display_name, is_seed, tools)
      VALUES ($1, $2, $1, $3, true, $4)
      ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password`,
    [name, passwordHash, ROLE_DESCRIPTIONS[name] ?? name, SEED_TOOLS]);
    if (row && row.password !== passwordHash) {
      await pool.query(`DELETE FROM ${authTable()} WHERE username=$1`, [name]);
    }
  }
}

/**
 * 早期创建的内置账号（admin 与各角色）只有历史默认能力：tools 为 rag_search，
 * 或是内置角色的五个工具，skills 为空。启动时仅对仍是历史默认值的账号补齐为
 * 当前全部可用能力；用户已改过的配置保持原样。
 */
export async function applyDefaultCapabilities(username: string, tools: string[], skills: string[]): Promise<void> {
  const toolsJson = JSON.stringify(tools);
  const skillsJson = JSON.stringify(skills);
  const legacyUserTools = JSON.stringify(["rag_search"]);
  const updateSql =
    `UPDATE ${usersTable()} SET tools = $2, skills = $3 ` +
    `WHERE username = $1 AND skills = '[]'::jsonb AND tools IN ($4::jsonb, $5::jsonb)`;
  await getPgPool().query(updateSql, [username, toolsJson, skillsJson, legacyUserTools, SEED_TOOLS]);
}

export async function registerTwin(
  username: string, password: string, displayName: string, persona: string, tools: string[], skills: string[],
): Promise<boolean> {
  for (const name of AGENT_NAMES) {
    if (username.toLowerCase() === name) return false;
  }
  const passwordHash = await hashPassword(password);
  const toolsJson = JSON.stringify(tools);
  const skillsJson = JSON.stringify(skills);
  const client = await getPgPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`INSERT INTO ${usersTable()} (username, password, display_name, persona, tools, skills)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (username) DO NOTHING RETURNING id`,
    [username, passwordHash, displayName || username, persona, toolsJson, skillsJson]);
    const row = result.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return false;
    }
    // 用数据库生成的用户 ID 构造稳定的 agent_key，并在同一事务创建私有知识表。
    const agentKey = `u${row.id}`;
    await client.query(`UPDATE ${usersTable()} SET agent_key = $2 WHERE id = $1`, [row.id, agentKey]);
    await ensureAgentTable(agentKey, client);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function tokenHash(token: string): string {
  const hash = createHash("sha256");
  hash.update(token);
  return hash.digest("hex");
}

export async function loginTwin(username: string, password: string): Promise<string | null> {
  const pool = getPgPool();
  const result = await pool.query(`SELECT password FROM ${usersTable()} WHERE username = $1`, [username]);
  const hash = result.rows[0]?.password;
  if (!hash || !await matchesPassword(password, hash)) return null;
  // 原始令牌交给登录入口设置 Cookie，数据库保存哈希和到期时间。
  const token = randomBytes(32).toString("hex");
  await pool.query(`INSERT INTO ${authTable()} (token_hash, username, expires_at)
    VALUES ($1, $2, now() + $3 * interval '1 second')`, [tokenHash(token), username, LOGIN_SECONDS]);
  return token;
}

export async function authenticateTwin(token: string): Promise<{ username: string; expires_at: Date } | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await getPgPool().query<{ username: string; expires_at: Date }>(`SELECT username, expires_at FROM ${authTable()}
    WHERE token_hash = $1 AND expires_at > now()`, [tokenHash(token)]);
  return result.rows[0] ?? null;
}

export async function logoutTwin(token: string): Promise<void> {
  await getPgPool().query(`DELETE FROM ${authTable()} WHERE token_hash = $1`, [tokenHash(token)]);
}

// 按调用方传入的账号顺序返回资料，会议执行依靠这个顺序识别主持人的数字人。
export async function getTwins(usernames: string[]): Promise<Twin[]> {
  const result = await getPgPool().query<Twin>(`SELECT ${TWIN_COLUMNS} FROM ${usersTable()}
    WHERE username = ANY($1::text[]) ORDER BY array_position($1::text[], username)`, [usernames]);
  return result.rows;
}

export async function listTwins(): Promise<Array<Pick<Twin, "username" | "agent_key" | "display_name" | "is_seed">>> {
  const result = await getPgPool().query(`SELECT username, agent_key, display_name, is_seed FROM ${usersTable()} ORDER BY id`);
  return result.rows;
}

export async function saveTwin(username: string, profile: TwinProfile): Promise<void> {
  const toolsJson = JSON.stringify(profile.tools);
  const skillsJson = JSON.stringify(profile.skills);
  await getPgPool().query(`UPDATE ${usersTable()} SET display_name = $2, persona = $3, memory = $4, tools = $5, skills = $6
    WHERE username = $1`, [username, profile.display_name, profile.persona, profile.memory, toolsJson, skillsJson]);
}
