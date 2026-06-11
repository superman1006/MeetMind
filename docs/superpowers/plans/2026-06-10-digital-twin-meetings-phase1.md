# 数字分身会议 · 第①期（数据与身份地基）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"用户=数字分身"的身份与"会议=多人参与的会话"的成员模型落到数据层，让会议能建、能按参与过滤、仅 master 可删——**完全不碰 LangGraph**。

**Architecture:** 复用现有 `meetmind_user` 表承载 twin（加 `agent_key`/`persona`/`tools`/`display_name`/`is_seed` 列，1:1）；`agent_key` 作唯一结构化身份（新用户 `u<id>`，5 个内置角色迁成 `is_seed` 种子分身、沿用旧名保住已灌表）；`meetmind_sessions` 加 `master`/`participants` 两列，列表按"我是 master 或在 participants 里"过滤，删除限定 master。所有改动走幂等 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，无 migration runner。

**Tech Stack:** TypeScript (ESM + NodeNext)、PostgreSQL (`pg` Pool)、vitest（pool 打桩，断言 SQL + 参数）、JSON-RPC over `POST /api`。

**约定（务必遵守，来自 CLAUDE.md）：**
- 相对 import 一律带 `.js` 后缀（即便源是 `.ts`）。
- state/响应字段用 snake_case；新加的 twin 字段在 DB 层用 snake_case 列名，TS 接口属性用 camelCase（如 `displayName`），映射在 store 函数里做。
- 表名只由受控 prefix + 受控 `agent_key`（`u<数字>` 或固定角色名）拼成，可安全内插；正文/参数一律 `$n` 占位符。
- 写注释优先中文，匹配现有风格；用显式 `for` 循环 + 具名中间变量，不要数组方法链做数据管道。
- 单文件测试命令：`pnpm --filter @meetmind/runtime exec vitest run <相对 apps/runtime 的路径>`。
- 全量类型检查：`pnpm --filter @meetmind/runtime typecheck`。

**本期不做（留给第②/③期）：** TwinAgent / 动态图 / per-twin 记忆 / per-twin 工具绑定执行 / 知识上传（`twin.uploadKnowledge`、`twin.listKnowledge`、`twin.toolCatalog`）/ 前端 UI。本期 `tools` 列只存不绑，`twin.list`/`twin.getProfile`/`twin.setProfile` 提供 profile 字段读写供后续期接入。

---

## File Structure

| 文件 | 改动 |
|---|---|
| `apps/runtime/src/database/users/userStore.ts` | 扩 DDL；扩 `createUser`（置 agent_key/persona/display_name）；新增 `TwinProfile` 接口、`getTwinByUsername`、`listTwins`、`setProfile`、`seedRoleTwins` |
| `apps/runtime/src/database/users/test/userStore.test.ts` | 补对应单测 |
| `apps/runtime/src/database/chat/chatStore.ts` | sessions 加 `master`/`participants` 列 + 回填 + GIN 索引；扩 `SessionMeta`；改 `createSession`/`listSessions`/`deleteSession` 签名与 SQL |
| `apps/runtime/src/database/chat/test/chatStore.test.ts` | 补对应单测 |
| `apps/runtime/src/server/rpcServer.ts` | `user.registry` 收 persona/displayName + 建 agent 表；`session.create` 收 participants；`session.delete` 收 username 鉴权；新增 `twin.list`/`twin.getProfile`/`twin.setProfile` |
| `apps/runtime/src/server/test/rpcServer.test.ts` | 更新既有 mock 形状 + 补新 method 单测 |
| `apps/runtime/src/bootstrap.ts` | 启动调用 `seedRoleTwins()` |

---

## Task 1: twins 表扩列 + agent_key 回填（DDL）

**Files:**
- Modify: `apps/runtime/src/database/users/userStore.ts:31-44`（`ensureUserTable`）
- Test: `apps/runtime/src/database/users/test/userStore.test.ts`

- [ ] **Step 1: 写失败测试**

在 `userStore.test.ts` 末尾追加（先在文件顶部的 import 行把 `ensureUserTable` 加进来：`import { createUser, verifyUser, getMemory, setMemory, ensureUserTable } from "../userStore.js";`）：

```ts
describe("ensureUserTable", () => {
  it("建表后用 ADD COLUMN IF NOT EXISTS 扩出 twin 字段，并回填 agent_key", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await ensureUserTable();

    const allSql = mockQuery.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allSql).toContain("ADD COLUMN IF NOT EXISTS persona TEXT");
    expect(allSql).toContain("ADD COLUMN IF NOT EXISTS tools JSONB NOT NULL DEFAULT '[]'");
    expect(allSql).toContain("ADD COLUMN IF NOT EXISTS agent_key TEXT");
    expect(allSql).toContain("ADD COLUMN IF NOT EXISTS display_name TEXT");
    expect(allSql).toContain("ADD COLUMN IF NOT EXISTS is_seed BOOLEAN NOT NULL DEFAULT false");
    expect(allSql).toContain("ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()");
    // agent_key 唯一约束
    expect(allSql).toContain("meetmind_user_agent_key_key");
    // 回填：给历史行（admin 等）补 agent_key = 'u' || id
    expect(allSql).toContain("UPDATE meetmind_user SET agent_key = 'u' || id WHERE agent_key IS NULL");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/users/test/userStore.test.ts`
Expected: FAIL — 新增的 `ensureUserTable` 用例里 `allSql` 不含这些子串。

- [ ] **Step 3: 改 `ensureUserTable`**

把 `userStore.ts` 的 `ensureUserTable`（31-44 行）整体替换为：

```ts
/** 建好 user 表（幂等）。bootstrap 里调一次。表即 twin：一行 = 一个数字分身。 */
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

  // 数字分身字段（幂等扩列，无 migration runner）：
  // persona       角色/人格描述，拼进 systemPrompt（第②期用）
  // tools         绑定的工具名列表（第②期才真正绑定，本期只存）
  // agent_key     唯一结构化身份：表名键 / 节点名 / 路由 token / config.configurable.agentName
  // display_name  仅展示名，随 SSE 下发前端
  // is_seed       标记 5 个预置种子分身
  await pool.query(`ALTER TABLE ${users} ADD COLUMN IF NOT EXISTS persona TEXT`);
  await pool.query(`ALTER TABLE ${users} ADD COLUMN IF NOT EXISTS tools JSONB NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE ${users} ADD COLUMN IF NOT EXISTS agent_key TEXT`);
  await pool.query(`ALTER TABLE ${users} ADD COLUMN IF NOT EXISTS display_name TEXT`);
  await pool.query(`ALTER TABLE ${users} ADD COLUMN IF NOT EXISTS is_seed BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE ${users} ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()`);

  // 给历史行（如 admin）回填 agent_key = 'u' || id（'u'+数字，天然 SQL 安全标识符）。
  await pool.query(`UPDATE ${users} SET agent_key = 'u' || id WHERE agent_key IS NULL`);

  // agent_key 唯一约束（幂等：约束已存在则 23505/42710 由 catch 吞掉）。约束名固定，便于断言。
  try {
    await pool.query(`ALTER TABLE ${users} ADD CONSTRAINT meetmind_user_agent_key_key UNIQUE (agent_key)`);
  } catch {
    // 约束已存在——幂等，忽略。
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/users/test/userStore.test.ts`
Expected: PASS（`ensureUserTable` 用例通过；其余既有用例不受影响）。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/database/users/userStore.ts apps/runtime/src/database/users/test/userStore.test.ts
git commit -m "feat(twin): user 表扩 twin 字段 + agent_key 回填"
```

---

## Task 2: `createUser` 注册时落 persona/display_name 并分配 agent_key

**Files:**
- Modify: `apps/runtime/src/database/users/userStore.ts:20-24`（`RegisterResult` 接口）、`62-74`（`createUser`）
- Test: `apps/runtime/src/database/users/test/userStore.test.ts`

- [ ] **Step 1: 写失败测试**

把 `userStore.test.ts` 里现有的 `describe("createUser", ...)` 整块替换为：

```ts
describe("createUser", () => {
  it("新用户：INSERT 命中行 → 分配 agent_key='u'||id，回填 persona/display_name，返回 {ok,agentKey}", async () => {
    // 第 1 次 query：INSERT ... RETURNING id
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "7" }], rowCount: 1 });
    // 第 2 次 query：UPDATE 回填 agent_key/persona/display_name
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await createUser("alice", "pw123", "我是后端老兵", "Alice 的分身");
    expect(result).toEqual({ ok: true, agentKey: "u7" });

    const insertSql = String(mockQuery.mock.calls[0][0]);
    expect(insertSql).toContain("INSERT INTO meetmind_user");
    expect(insertSql).toContain("ON CONFLICT (username) DO NOTHING");
    expect(insertSql).toContain("RETURNING id");
    expect(mockQuery.mock.calls[0][1]).toEqual(["alice", "pw123"]);

    const updateSql = String(mockQuery.mock.calls[1][0]);
    expect(updateSql).toContain("UPDATE meetmind_user SET agent_key = $2, persona = $3, display_name = $4");
    expect(updateSql).toContain("WHERE id = $1");
    // id 来自 RETURNING；agent_key 由 'u'+id 在 JS 里算好，仍走 $n 占位符（数字派生，安全）
    expect(mockQuery.mock.calls[1][1]).toEqual(["7", "u7", "我是后端老兵", "Alice 的分身"]);
  });

  it("display_name 省略时默认用 username", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "8" }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await createUser("bob", "pw", "");
    expect(result).toEqual({ ok: true, agentKey: "u8" });
    expect(mockQuery.mock.calls[1][1]).toEqual(["8", "u8", "", "bob"]);
  });

  it("用户名已存在：INSERT 无返回行 → ok:false reason:exists，不再发 UPDATE", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await createUser("admin", "whatever", "x");
    expect(result).toEqual({ ok: false, reason: "exists" });
    // 冲突时只发了 1 次 query（INSERT），没有 UPDATE
    expect(mockQuery.mock.calls.length).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/users/test/userStore.test.ts`
Expected: FAIL —`createUser` 现签名只收 2 参、不返回 `agentKey`、不发 UPDATE。

- [ ] **Step 3: 改 `RegisterResult` 接口与 `createUser`**

`RegisterResult` 接口（20-24 行）改为：

```ts
/** 注册结果。成功 ok:true + 新分身的 agent_key；用户名已存在 ok:false + reason:"exists"。 */
export interface RegisterResult {
  ok: boolean;
  reason?: "exists";
  agentKey?: string;
}
```

`createUser`（62-74 行）整体替换为：

```ts
/**
 * 注册新分身。INSERT ... ON CONFLICT DO NOTHING 原子判重；命中（返回行）→ 拿到自增 id，
 * 算 agent_key = 'u' || id（'u'+数字，天然 SQL 安全标识符），再 UPDATE 回填 agent_key/persona/display_name。
 * display_name 为空时默认用 username。明文存密码（本地 demo）。
 */
export async function createUser(
  username: string,
  password: string,
  persona: string,
  displayName?: string,
): Promise<RegisterResult> {
  const pool = getPgPool();
  const users = usersTable();

  const insertSql =
    `INSERT INTO ${users} (username, password) VALUES ($1, $2) ` +
    `ON CONFLICT (username) DO NOTHING RETURNING id`;
  const insertResult = await pool.query(insertSql, [username, password]);
  if (insertResult.rows.length === 0) {
    return { ok: false, reason: "exists" };
  }

  const id = String(insertResult.rows[0].id);
  const agentKey = `u${id}`;
  const finalDisplayName = displayName ? displayName : username;

  const updateSql =
    `UPDATE ${users} SET agent_key = $2, persona = $3, display_name = $4 WHERE id = $1`;
  await pool.query(updateSql, [id, agentKey, persona, finalDisplayName]);

  return { ok: true, agentKey };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/users/test/userStore.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/database/users/userStore.ts apps/runtime/src/database/users/test/userStore.test.ts
git commit -m "feat(twin): createUser 注册时落 persona/display_name 并分配 agent_key"
```

---

## Task 3: twin 读写助手 `getTwinByUsername` / `listTwins` / `setProfile`

**Files:**
- Modify: `apps/runtime/src/database/users/userStore.ts`（在文件末尾、`setMemory` 之后追加）
- Test: `apps/runtime/src/database/users/test/userStore.test.ts`

- [ ] **Step 1: 写失败测试**

在 `userStore.test.ts` 末尾追加（并把这三个函数加进顶部 import）：

```ts
describe("getTwinByUsername", () => {
  it("命中：返回 twin 资料（DB snake_case → camelCase 映射）", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        username: "alice", display_name: "Alice 的分身", persona: "后端老兵",
        tools: ["rag_search", "Read"], agent_key: "u7", is_seed: false,
      }],
      rowCount: 1,
    });
    const twin = await getTwinByUsername("alice");
    expect(twin).toEqual({
      username: "alice", displayName: "Alice 的分身", persona: "后端老兵",
      tools: ["rag_search", "Read"], agentKey: "u7", isSeed: false,
    });
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("FROM meetmind_user");
    expect(sql).toContain("WHERE username = $1");
    expect(mockQuery.mock.calls[0][1]).toEqual(["alice"]);
  });

  it("未命中 → null；persona/tools 为 NULL 时兜底空串/空数组", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await getTwinByUsername("ghost")).toBeNull();

    mockQuery.mockResolvedValueOnce({
      rows: [{ username: "bob", display_name: null, persona: null, tools: null, agent_key: "u8", is_seed: false }],
      rowCount: 1,
    });
    const twin = await getTwinByUsername("bob");
    expect(twin).toEqual({ username: "bob", displayName: "bob", persona: "", tools: [], agentKey: "u8", isSeed: false });
  });
});

describe("listTwins", () => {
  it("列全部分身：种子在前，映射成 {username,displayName,isSeed}", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { username: "architect", display_name: "架构师", is_seed: true },
        { username: "alice", display_name: "Alice 的分身", is_seed: false },
      ],
      rowCount: 2,
    });
    const twins = await listTwins();
    expect(twins).toEqual([
      { username: "architect", displayName: "架构师", isSeed: true },
      { username: "alice", displayName: "Alice 的分身", isSeed: false },
    ]);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("SELECT username, display_name, is_seed FROM meetmind_user");
    expect(sql).toContain("ORDER BY is_seed DESC, username ASC");
  });
});

describe("setProfile", () => {
  it("只更新传入的字段（display_name + tools），走 $n 占位符", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await setProfile("alice", { displayName: "新名", tools: ["rag_search"] });
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("UPDATE meetmind_user SET");
    expect(sql).toContain("display_name = $2");
    expect(sql).toContain("tools = $3");
    expect(sql).toContain("WHERE username = $1");
    // tools 作为 jsonb 文本传入（::jsonb 由 SQL 标注）
    expect(mockQuery.mock.calls[0][1]).toEqual(["alice", "新名", JSON.stringify(["rag_search"])]);
  });

  it("没有任何可更新字段时不发 query（空操作）", async () => {
    await setProfile("alice", {});
    expect(mockQuery.mock.calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/users/test/userStore.test.ts`
Expected: FAIL — 三个函数未定义。

- [ ] **Step 3: 实现三个助手**

在 `userStore.ts` 末尾追加：

```ts
/** 一个数字分身的资料（getTwinByUsername 返回；DB snake_case 已映射成 camelCase）。 */
export interface TwinProfile {
  username: string;
  displayName: string;
  persona: string;
  tools: string[];
  agentKey: string;
  isSeed: boolean;
}

/** 列表用的精简分身条目（参与者选择器 / 个人页）。 */
export interface TwinListItem {
  username: string;
  displayName: string;
  isSeed: boolean;
}

/** 按 username 取一个分身的完整资料。未命中返回 null；persona/tools 为空时兜底空串/空数组。 */
export async function getTwinByUsername(username: string): Promise<TwinProfile | null> {
  const pool = getPgPool();
  const users = usersTable();
  const selectSql =
    `SELECT username, display_name, persona, tools, agent_key, is_seed ` +
    `FROM ${users} WHERE username = $1`;
  const result = await pool.query(selectSql, [username]);
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  // tools 是 jsonb，pg 驱动已 parse 成数组；NULL/非数组兜底空数组。
  const tools = Array.isArray(row.tools) ? (row.tools as string[]) : [];
  const displayName = row.display_name ? String(row.display_name) : String(row.username);
  return {
    username: String(row.username),
    displayName,
    persona: row.persona ?? "",
    tools,
    agentKey: String(row.agent_key),
    isSeed: row.is_seed === true,
  };
}

/** 列出所有数字分身（种子分身在前），给参与者选择器 / 个人页用。 */
export async function listTwins(): Promise<TwinListItem[]> {
  const pool = getPgPool();
  const users = usersTable();
  const selectSql =
    `SELECT username, display_name, is_seed FROM ${users} ` +
    `ORDER BY is_seed DESC, username ASC`;
  const result = await pool.query(selectSql, []);
  const items: TwinListItem[] = [];
  for (const row of result.rows) {
    const displayName = row.display_name ? String(row.display_name) : String(row.username);
    items.push({ username: String(row.username), displayName, isSeed: row.is_seed === true });
  }
  return items;
}

/** 个人页改资料：只更新传入的字段（display_name / persona / tools 任意子集）。无字段则空操作。 */
export async function setProfile(
  username: string,
  patch: { displayName?: string; persona?: string; tools?: string[] },
): Promise<void> {
  // 显式拼 SET 子句（不用数组方法链），$1 永远是 username。
  const setClauses: string[] = [];
  const values: unknown[] = [username];

  if (patch.displayName !== undefined) {
    values.push(patch.displayName);
    setClauses.push(`display_name = $${values.length}`);
  }
  if (patch.persona !== undefined) {
    values.push(patch.persona);
    setClauses.push(`persona = $${values.length}`);
  }
  if (patch.tools !== undefined) {
    values.push(JSON.stringify(patch.tools));
    setClauses.push(`tools = $${values.length}::jsonb`);
  }
  if (setClauses.length === 0) {
    return;
  }

  const pool = getPgPool();
  const users = usersTable();
  const updateSql = `UPDATE ${users} SET ${setClauses.join(", ")} WHERE username = $1`;
  await pool.query(updateSql, values);
}
```

把这三个函数 + 两个接口加进 `userStore.test.ts` 顶部 import：
`import { createUser, verifyUser, getMemory, setMemory, ensureUserTable, getTwinByUsername, listTwins, setProfile } from "../userStore.js";`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/users/test/userStore.test.ts`
Expected: PASS。

注：测试里 `setProfile` 的 tools 断言期望 SQL 含 `tools = $3`，而实现里是 `tools = $3::jsonb`——`toContain("tools = $3")` 是子串匹配，`$3::jsonb` 含 `$3` 故仍通过。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/database/users/userStore.ts apps/runtime/src/database/users/test/userStore.test.ts
git commit -m "feat(twin): 新增 getTwinByUsername/listTwins/setProfile 助手"
```

---

## Task 4: `seedRoleTwins` —— 把 5 个内置角色迁成种子分身

**Files:**
- Modify: `apps/runtime/src/database/users/userStore.ts`（末尾追加；需 import 常量）
- Test: `apps/runtime/src/database/users/test/userStore.test.ts`

> 5 个角色的 RAG 表（`meetmind_architect` 等）已由现有 `buildAgentsTables()` 在 bootstrap 灌好；本任务只插 user 行，`agent_key` 沿用角色名以复用那些表。`is_seed=true`，password 设一个不可登录的哨兵值。

- [ ] **Step 1: 写失败测试**

`userStore.test.ts` 末尾追加（并把 `seedRoleTwins` 加进 import）：

```ts
describe("seedRoleTwins", () => {
  it("为 5 个内置角色各发一条 ON CONFLICT DO UPDATE 的 upsert，agent_key=角色名、is_seed=true", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await seedRoleTwins();

    // 5 个角色 → 5 次 upsert
    expect(mockQuery.mock.calls.length).toBe(5);

    const firstSql = String(mockQuery.mock.calls[0][0]);
    expect(firstSql).toContain("INSERT INTO meetmind_user");
    expect(firstSql).toContain("ON CONFLICT (username) DO UPDATE");
    // upsert 列含 twin 字段
    expect(firstSql).toContain("agent_key");
    expect(firstSql).toContain("display_name");
    expect(firstSql).toContain("persona");
    expect(firstSql).toContain("is_seed");

    // 收集所有 upsert 的参数，确认 5 个角色都在、agent_key==username、is_seed==true
    const seededUsernames: string[] = [];
    for (const call of mockQuery.mock.calls) {
      const p = call[1] as unknown[];
      // 约定参数顺序：[username, password, agentKey, displayName, persona, isSeed]
      expect(p[2]).toBe(p[0]); // agent_key === username（角色名）
      expect(p[5]).toBe(true); // is_seed
      seededUsernames.push(String(p[0]));
    }
    expect(seededUsernames.sort()).toEqual(["architect", "backend", "frontend", "pm", "tester"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/users/test/userStore.test.ts`
Expected: FAIL — `seedRoleTwins` 未定义。

- [ ] **Step 3: 实现 `seedRoleTwins`**

`userStore.ts` 顶部 import 区加（注意 `.js` 后缀）：

```ts
import { AGENT_NAMES, ROLE_DESCRIPTIONS } from "../../config/constants.js";
```

文件末尾追加：

```ts
/** 种子分身登录哨兵密码——明文比对永不命中（5 个内置角色不作为真人登录账号，但可被选入会议）。 */
const SEED_TWIN_PASSWORD = "__seed_no_login__";

/**
 * 把 5 个内置角色（architect/backend/frontend/tester/pm）迁成种子分身行（幂等）。
 * agent_key 沿用角色名 → 复用它们已灌的 RAG 表（meetmind_architect 等）。
 * 用 ON CONFLICT DO UPDATE 刷新 display_name/persona/is_seed，便于改文案后重启即更新。
 */
export async function seedRoleTwins(): Promise<void> {
  const pool = getPgPool();
  const users = usersTable();

  const upsertSql =
    `INSERT INTO ${users} (username, password, agent_key, display_name, persona, is_seed) ` +
    `VALUES ($1, $2, $3, $4, $5, $6) ` +
    `ON CONFLICT (username) DO UPDATE SET ` +
    `  agent_key = EXCLUDED.agent_key,` +
    `  display_name = EXCLUDED.display_name,` +
    `  persona = EXCLUDED.persona,` +
    `  is_seed = EXCLUDED.is_seed`;

  // 显式逐个角色 upsert（不用数组方法链）。
  for (const role of AGENT_NAMES) {
    const label = ROLE_DESCRIPTIONS[role];
    const persona = `你是${label}，负责从${label}的专业视角参与团队会议讨论。`;
    await pool.query(upsertSql, [role, SEED_TWIN_PASSWORD, role, label, persona, true]);
  }
}
```

import 行补上 `seedRoleTwins`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/users/test/userStore.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/database/users/userStore.ts apps/runtime/src/database/users/test/userStore.test.ts
git commit -m "feat(twin): seedRoleTwins 把 5 个内置角色迁成种子分身"
```

---

## Task 5: bootstrap 启动时调用 `seedRoleTwins`

**Files:**
- Modify: `apps/runtime/src/bootstrap.ts`（在 `ensureUserTable()` + `seedAdminUser()` 之后、`buildAgentsTables()` 之后均可——见下）

> bootstrap 无单测，本任务用手动验证（连真库跑一次）。注意顺序：`ensureUserTable`（扩列）→ `seedAdminUser`（admin 行 + 触发回填）→ `buildAgentsTables`（建好 5 个角色的 RAG 表）→ `seedRoleTwins`（插 5 个角色 user 行，依赖前面扩好的列；RAG 表此时已在）。

- [ ] **Step 1: 读现有 bootstrap 启动序列**

Run: `grep -n "ensureUserTable\|seedAdminUser\|buildAgentsTables" apps/runtime/src/bootstrap.ts`
确认 `ensureUserTable()` / `seedAdminUser()`（约 70-71 行）与 `buildAgentsTables()`（约 134 行）的调用点。

- [ ] **Step 2: 在 `buildAgentsTables()` 之后插入 `seedRoleTwins()` 调用**

在 bootstrap 顶部 import 区把 `seedRoleTwins` 加入对 `userStore` 的 import（与 `ensureUserTable`/`seedAdminUser` 同一来源 `./database/users/userStore.js`）。

在 `await buildAgentsTables();` 这一行的**紧后面**加：

```ts
  // 把 5 个内置角色迁成种子分身（user 行）；它们的 RAG 表已由 buildAgentsTables 灌好，agent_key 沿用角色名即复用。
  await seedRoleTwins();
```

- [ ] **Step 3: 手动验证（连真库）**

确保 docker 起着：`docker compose up -d`。重启 runtime 验证不报错：

Run: `pnpm --filter @meetmind/runtime exec tsx -e "import('./src/database/connection/client.js').then(async (c)=>{const {ensureUserTable,seedAdminUser,seedRoleTwins,listTwins}=await import('./src/database/users/userStore.js');await ensureUserTable();await seedAdminUser();await seedRoleTwins();console.log(await listTwins());process.exit(0)})"`

Expected: 打印出含 5 个种子分身（architect/backend/frontend/tester/pm，`isSeed:true`）+ admin（`isSeed:false`）的数组，无异常。

- [ ] **Step 4: 类型检查**

Run: `pnpm --filter @meetmind/runtime typecheck`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/bootstrap.ts
git commit -m "feat(twin): bootstrap 启动时迁种子分身"
```

---

## Task 6: sessions 加 `master`/`participants` 列 + 回填 + GIN 索引

**Files:**
- Modify: `apps/runtime/src/database/chat/chatStore.ts:39-110`（`ensureChatTables`）
- Test: `apps/runtime/src/database/chat/test/chatStore.test.ts`

- [ ] **Step 1: 看现有 chatStore 测试的打桩方式**

Run: `sed -n '1,30p' apps/runtime/src/database/chat/test/chatStore.test.ts`
确认它和 `userStore.test.ts` 同款（`vi.hoisted` 的 `mockQuery` + `vi.mock` 打桩 pool 与 settings）。

- [ ] **Step 2: 写失败测试**

在 `chatStore.test.ts` 末尾追加（把 `ensureChatTables` 加进 import）：

```ts
describe("ensureChatTables · 会议成员列", () => {
  it("加 master/participants 列、回填 master:=owner、建 participants 的 GIN 索引", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await ensureChatTables();
    const allSql = mockQuery.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allSql).toContain("ADD COLUMN IF NOT EXISTS master TEXT");
    expect(allSql).toContain("ADD COLUMN IF NOT EXISTS participants JSONB NOT NULL DEFAULT '[]'");
    expect(allSql).toContain("UPDATE meetmind_sessions SET master = owner WHERE master IS NULL");
    expect(allSql).toContain("USING GIN (participants)");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/chat/test/chatStore.test.ts`
Expected: FAIL — `allSql` 不含新子串。

- [ ] **Step 4: 改 `ensureChatTables`**

在 `ensureChatTables` 里、`pending_thread_id` 那条 ALTER（约 65 行）之后、`summary` ALTER 之前，插入：

```ts
  // 会议成员模型：master=主持人 username（发起人）、participants=其他参与人 username 列表（不含 master）。
  await pool.query(`ALTER TABLE ${sessions} ADD COLUMN IF NOT EXISTS master TEXT`);
  await pool.query(`ALTER TABLE ${sessions} ADD COLUMN IF NOT EXISTS participants JSONB NOT NULL DEFAULT '[]'`);
  // 历史行回填：master 取原 owner。
  await pool.query(`UPDATE ${sessions} SET master = owner WHERE master IS NULL`);
```

在现有 owner 索引（74-78 行）之后，追加 participants 的 GIN 索引（支撑 `@>` 包含查询）：

```ts
  // participants 上建 GIN 索引，给「我在参与者里」的 @> 包含查询提速。
  const participantsIndexSql =
    `CREATE INDEX IF NOT EXISTS ${sessions}_participants_idx ` +
    `ON ${sessions} USING GIN (participants)`;
  await pool.query(participantsIndexSql);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/chat/test/chatStore.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/runtime/src/database/chat/chatStore.ts apps/runtime/src/database/chat/test/chatStore.test.ts
git commit -m "feat(meeting): sessions 加 master/participants 列 + 回填 + GIN 索引"
```

---

## Task 7: `SessionMeta` 扩字段 + `createSession(title, master, participants)`

**Files:**
- Modify: `apps/runtime/src/database/chat/chatStore.ts:20-26`（`SessionMeta`）、`112-125`（`createSession`）
- Test: `apps/runtime/src/database/chat/test/chatStore.test.ts`

- [ ] **Step 1: 写失败测试**

替换 `chatStore.test.ts` 里现有的 `createSession` 用例（若有；没有则新增）为：

```ts
describe("createSession", () => {
  it("写入 owner=master、master、participants(jsonb)，返回含 master/participants/isMaster:true 的 meta", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "uuid-1", title: "登录页会议", created_at: "2026-06-10T00:00:00Z" }],
      rowCount: 1,
    });
    const meta = await createSession("登录页会议", "alice", ["architect", "bob"]);
    expect(meta).toEqual({
      id: "uuid-1",
      title: "登录页会议",
      created_at: "2026-06-10T00:00:00Z",
      ended: false,
      master: "alice",
      participants: ["architect", "bob"],
      isMaster: true,
    });
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO meetmind_sessions");
    expect(sql).toContain("owner, master, participants");
    // participants 作为 jsonb 文本传入
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[2]).toBe("alice");          // owner = master
    expect(params[3]).toBe("alice");          // master
    expect(params[4]).toBe(JSON.stringify(["architect", "bob"])); // participants jsonb 文本
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/chat/test/chatStore.test.ts`
Expected: FAIL — `createSession` 现签名是 `(title, owner)`、返回的 meta 无 master/participants/isMaster。

- [ ] **Step 3: 扩 `SessionMeta` 并改 `createSession`**

`SessionMeta`（20-26 行）替换为：

```ts
/** 会话（=会议）元信息（列表 / 创建返回用）。 */
export interface SessionMeta {
  id: string;
  title: string;
  created_at: string;
  ended: boolean;
  master: string;          // 主持人 username（发起人）
  participants: string[];  // 其他参与人 username 列表（不含 master）
  isMaster: boolean;       // 请求者是否 = master（决定前端是否显示删除按钮）
}
```

`createSession`（112-125 行）替换为：

```ts
/**
 * 新建一个会议。master=发起人 username，participants=其他参与人 username（不含 master）。
 * owner 列继续写 master（兼容 getSessionOwner / runExecution 的按 owner 取记忆逻辑，本期不动）。
 * 返回 meta 的 isMaster 恒为 true（创建者就是 master）。
 */
export async function createSession(
  title: string,
  master: string,
  participants: string[],
): Promise<SessionMeta> {
  const pool = getPgPool();
  const id = randomUUID();
  const participantsJson = JSON.stringify(participants);
  const insertSql =
    `INSERT INTO ${sessionsTable()} (id, title, owner, master, participants) ` +
    `VALUES ($1, $2, $3, $4, $5::jsonb) ` +
    `RETURNING id, title, created_at`;
  const result = await pool.query(insertSql, [id, title, master, master, participantsJson]);
  const row = result.rows[0];
  return {
    id: row.id,
    title: row.title,
    created_at: String(row.created_at),
    ended: false,
    master,
    participants,
    isMaster: true,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/chat/test/chatStore.test.ts`
Expected: PASS。

> 注：此改动会让 `rpcServer.ts:336` 的 `createSession(title, username)` 调用与 `rpcServer.test.ts` 的 mock 类型不匹配——在 Task 9/10 修复。本任务只跑 chatStore 单测，不跑 typecheck。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/database/chat/chatStore.ts apps/runtime/src/database/chat/test/chatStore.test.ts
git commit -m "feat(meeting): SessionMeta 扩 master/participants/isMaster + createSession 收参与者"
```

---

## Task 8: `listSessions(username)` 参与者感知 + 算 `isMaster`

**Files:**
- Modify: `apps/runtime/src/database/chat/chatStore.ts:127-141`（`listSessions`）
- Test: `apps/runtime/src/database/chat/test/chatStore.test.ts`

- [ ] **Step 1: 写失败测试**

替换/新增 `listSessions` 用例：

```ts
describe("listSessions", () => {
  it("过滤 master=我 或 participants 含我；逐行算 isMaster", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "s1", title: "我主持的", created_at: "2026-06-10T02:00:00Z", ended: false, master: "alice", participants: ["bob"] },
        { id: "s2", title: "我参与的", created_at: "2026-06-10T01:00:00Z", ended: true, master: "bob", participants: ["alice", "architect"] },
      ],
      rowCount: 2,
    });
    const list = await listSessions("alice");
    expect(list).toEqual([
      { id: "s1", title: "我主持的", created_at: "2026-06-10T02:00:00Z", ended: false, master: "alice", participants: ["bob"], isMaster: true },
      { id: "s2", title: "我参与的", created_at: "2026-06-10T01:00:00Z", ended: true, master: "bob", participants: ["alice", "architect"], isMaster: false },
    ]);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("WHERE master = $1 OR participants @> to_jsonb($1::text)");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(mockQuery.mock.calls[0][1]).toEqual(["alice"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/chat/test/chatStore.test.ts`
Expected: FAIL。

- [ ] **Step 3: 改 `listSessions`**

`listSessions`（127-141 行）替换为：

```ts
/** 列出某用户参与的会议（我是 master 或在 participants 里），最近创建在前。 */
export async function listSessions(username: string): Promise<SessionMeta[]> {
  const pool = getPgPool();
  const selectSql =
    `SELECT id, title, created_at, ended, master, participants FROM ${sessionsTable()} ` +
    `WHERE master = $1 OR participants @> to_jsonb($1::text) ` +
    `ORDER BY created_at DESC`;
  const result = await pool.query(selectSql, [username]);
  const metas: SessionMeta[] = [];
  for (const row of result.rows) {
    // participants 是 jsonb，pg 驱动已 parse 成数组；NULL 兜底空数组。
    const participants = Array.isArray(row.participants) ? (row.participants as string[]) : [];
    const master = String(row.master ?? "");
    metas.push({
      id: row.id,
      title: row.title,
      created_at: String(row.created_at),
      ended: row.ended === true,
      master,
      participants,
      isMaster: master === username,
    });
  }
  return metas;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/chat/test/chatStore.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/database/chat/chatStore.ts apps/runtime/src/database/chat/test/chatStore.test.ts
git commit -m "feat(meeting): listSessions 改为参与者感知 + 算 isMaster"
```

---

## Task 9: `deleteSession(sessionId, requester)` 仅 master 可删

**Files:**
- Modify: `apps/runtime/src/database/chat/chatStore.ts:314-320`（`deleteSession`）
- Test: `apps/runtime/src/database/chat/test/chatStore.test.ts`

- [ ] **Step 1: 写失败测试**

新增/替换 `deleteSession` 用例：

```ts
describe("deleteSession", () => {
  it("requester 是 master：删成功（rowCount>0）→ 返回 true，SQL 带 master 条件", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const ok = await deleteSession("s1", "alice");
    expect(ok).toBe(true);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("DELETE FROM meetmind_sessions WHERE id = $1 AND master = $2");
    expect(mockQuery.mock.calls[0][1]).toEqual(["s1", "alice"]);
  });

  it("requester 不是 master：影响 0 行 → 返回 false（不删）", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const ok = await deleteSession("s1", "bob");
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/chat/test/chatStore.test.ts`
Expected: FAIL — 现 `deleteSession` 只收 1 参、无返回值、SQL 无 master 条件。

- [ ] **Step 3: 改 `deleteSession`**

`deleteSession`（314-320 行）替换为：

```ts
/**
 * 删除某会议（messages 靠外键 ON DELETE CASCADE 一并删）——仅当 requester == master 才删。
 * 返回是否真的删除了（rowCount>0）：false 表示请求者不是发起人，上游据此回拒绝。
 */
export async function deleteSession(sessionId: string, requester: string): Promise<boolean> {
  const pool = getPgPool();
  const deleteSql = `DELETE FROM ${sessionsTable()} WHERE id = $1 AND master = $2`;
  const result = await pool.query(deleteSql, [sessionId, requester]);
  return (result.rowCount ?? 0) > 0;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/database/chat/test/chatStore.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/database/chat/chatStore.ts apps/runtime/src/database/chat/test/chatStore.test.ts
git commit -m "feat(meeting): deleteSession 仅 master 可删，返回是否删除"
```

---

## Task 10: RPC `user.registry` 收 persona/displayName + 注册时建 agent 表

**Files:**
- Modify: `apps/runtime/src/server/rpcServer.ts:70-81`（`user.registry` 分支）；顶部 import
- Test: `apps/runtime/src/server/test/rpcServer.test.ts`

- [ ] **Step 1: 写失败测试**

在 `rpcServer.test.ts` 顶部，仿照既有 `vi.mock` 给 `connection/client.js` 打桩（避免真建表 / 真加载 embedding 模型）。在现有 `vi.mock(...)` 块之后加：

```ts
// user.registry 注册成功后会建该 twin 的 RAG 表。单测里 mock 成 no-op，避免加载 embedding 模型 / 连库。
vi.mock("../../database/connection/client.js", () => ({
  ensureExtensions: vi.fn(() => Promise.resolve()),
  ensureAgentTable: vi.fn(() => Promise.resolve()),
}));
import * as dbClient from "../../database/connection/client.js";
```

> 若 `rpcServer.ts` 间接 import 了 `connection/client.js` 的其它导出，这个 mock 工厂需补齐被用到的导出（运行时报 “xxx is not a function” 时按报错补 `xxx: vi.fn()`）。本任务只在 user.registry 路径用到 `ensureExtensions`/`ensureAgentTable`。

在 `describe("handleRpc", ...)` 内补用例：

```ts
it("user.registry 带 persona/displayName：调 createUser 并为新分身建 agent 表", async () => {
  vi.spyOn(userStore, "createUser").mockResolvedValue({ ok: true, agentKey: "u7" });
  const res = await handleRpc(graphHolder, {
    jsonrpc: "2.0", id: 10, method: "user.registry",
    params: { username: "alice", password: "pw", persona: "后端老兵", displayName: "Alice 的分身" },
  });
  expect(res).toMatchObject({ result: { ok: true } });
  expect(userStore.createUser).toHaveBeenCalledWith("alice", "pw", "后端老兵", "Alice 的分身");
  // 用返回的 agentKey 建表
  expect(dbClient.ensureAgentTable).toHaveBeenCalledWith("u7");
});

it("user.registry 缺 persona 返回 -32602", async () => {
  const res = (await handleRpc(graphHolder, {
    jsonrpc: "2.0", id: 11, method: "user.registry",
    params: { username: "alice", password: "pw" },
  })) as { error?: { code: number } };
  expect(res.error?.code).toBe(-32602);
});

it("user.registry 用户名已存在：回 {ok:false,reason:'exists'}，不建表", async () => {
  vi.spyOn(userStore, "createUser").mockResolvedValue({ ok: false, reason: "exists" });
  const res = await handleRpc(graphHolder, {
    jsonrpc: "2.0", id: 12, method: "user.registry",
    params: { username: "admin", password: "pw", persona: "x" },
  });
  expect(res).toMatchObject({ result: { ok: false, reason: "exists" } });
  expect(dbClient.ensureAgentTable).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/test/rpcServer.test.ts`
Expected: FAIL — 现 `user.registry` 不收 persona、不建表。

- [ ] **Step 3: 改 `user.registry` 分支**

`rpcServer.ts` 顶部 import 区加：

```ts
import { ensureExtensions, ensureAgentTable } from "../database/connection/client.js";
```

`user.registry` 分支（70-81 行）替换为：

```ts
  // user.registry:注册新数字分身。校验 username/password/persona 非空（displayName 可选,默认=username）。
  // 注册成功后用返回的 agent_key 为这个分身建一张私有 RAG 表（空表;之后个人页上传知识灌入）。
  if (body.method === "user.registry") {
    const username = params.username;
    const password = params.password;
    const persona = params.persona;
    const displayName = params.displayName;
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      return rpcError(id, -32602, "缺少 username 或 password");
    }
    if (typeof persona !== "string" || !persona) {
      return rpcError(id, -32602, "缺少 persona（角色描述）");
    }
    const finalDisplayName = (typeof displayName === "string" && displayName) ? displayName : undefined;
    const result = await userStore.createUser(username, password, persona, finalDisplayName);
    if (!result.ok) {
      return rpcOk(id, { ok: false, reason: result.reason });
    }
    // 为新分身建私有表（agentKey 来自 createUser；ensureExtensions 幂等）。
    await ensureExtensions();
    await ensureAgentTable(result.agentKey as string);
    return rpcOk(id, { ok: true });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/test/rpcServer.test.ts`
Expected: PASS（新用例通过；下个任务修既有 session.create 用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/server/rpcServer.ts apps/runtime/src/server/test/rpcServer.test.ts
git commit -m "feat(twin): user.registry 收 persona/displayName 并建私有表"
```

---

## Task 11: RPC `session.create` 收 participants（并修既有 mock 形状）

**Files:**
- Modify: `apps/runtime/src/server/rpcServer.ts:329-338`（`session.create` 分支）
- Test: `apps/runtime/src/server/test/rpcServer.test.ts`

- [ ] **Step 1: 修既有 mock 形状 + 改/加用例**

先把 `rpcServer.test.ts` 的 `beforeEach` 里两处 mock 返回值补齐新字段（否则 TS 报 SessionMeta 缺字段）：

`vi.spyOn(chatStore, "createSession")` 的 `mockResolvedValue` 改为：

```ts
    vi.spyOn(chatStore, "createSession").mockResolvedValue({
      id: "new-id", title: "新会话", created_at: "2026-06-01T00:00:00Z",
      ended: false, master: "alice", participants: [], isMaster: true,
    });
```

`vi.spyOn(chatStore, "listSessions")` 的 `mockResolvedValue` 改为：

```ts
    vi.spyOn(chatStore, "listSessions").mockResolvedValue([
      { id: "a", title: "会话A", created_at: "2026-06-01T00:00:00Z",
        ended: false, master: "alice", participants: [], isMaster: true },
    ]);
```

`vi.spyOn(chatStore, "deleteSession")` 的 `mockResolvedValue(undefined)` 改为 `mockResolvedValue(true)`（新签名返回 boolean）。

再把既有的 `session.create` 用例（断言 `createSession` 被 `("我的会话","alice")` 调）替换为：

```ts
it("session.create 带 username + participants 透传给 createSession(title, master, participants)", async () => {
  const res = await handleRpc(graphHolder, {
    jsonrpc: "2.0", id: 4, method: "session.create",
    params: { title: "我的会议", username: "alice", participants: ["architect", "bob"] },
  });
  expect(res).toMatchObject({ result: { id: "new-id" } });
  expect(chatStore.createSession).toHaveBeenCalledWith("我的会议", "alice", ["architect", "bob"]);
});

it("session.create 不传 participants 时默认空数组", async () => {
  await handleRpc(graphHolder, {
    jsonrpc: "2.0", id: 5, method: "session.create",
    params: { title: "我的会议", username: "alice" },
  });
  expect(chatStore.createSession).toHaveBeenCalledWith("我的会议", "alice", []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/test/rpcServer.test.ts`
Expected: FAIL — 现 `session.create` 调 `createSession(title, username)`（两参）。

- [ ] **Step 3: 改 `session.create` 分支**

`session.create` 分支（329-338 行）替换为：

```ts
  // session.create:新建会议。master=当前登录用户 username,participants=其他参与人 username 列表(可空)。
  if (body.method === "session.create") {
    const username = params.username;
    if (typeof username !== "string" || !username) {
      return rpcError(id, -32602, "缺少 username");
    }
    const rawTitle = params.title;
    const title = (typeof rawTitle === "string" && rawTitle) ? rawTitle : "新会话";
    // participants 必须是字符串数组;没传 / 非数组一律当空数组。逐项校验为字符串,过滤掉非法项。
    const rawParticipants = params.participants;
    const participants: string[] = [];
    if (Array.isArray(rawParticipants)) {
      for (const p of rawParticipants) {
        if (typeof p === "string" && p) {
          participants.push(p);
        }
      }
    }
    const meta = await chatStore.createSession(title, username, participants);
    return rpcOk(id, meta);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/test/rpcServer.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/server/rpcServer.ts apps/runtime/src/server/test/rpcServer.test.ts
git commit -m "feat(meeting): session.create 收 participants"
```

---

## Task 12: RPC `session.delete` 收 username 并做 master 鉴权

**Files:**
- Modify: `apps/runtime/src/server/rpcServer.ts:374-385`（`session.delete` 分支）
- Test: `apps/runtime/src/server/test/rpcServer.test.ts`

- [ ] **Step 1: 写失败测试**

补用例：

```ts
it("session.delete:requester 是 master(deleteSession 回 true)→ ok", async () => {
  vi.spyOn(chatStore, "deleteSession").mockResolvedValue(true);
  const res = await handleRpc(graphHolder, {
    jsonrpc: "2.0", id: 20, method: "session.delete",
    params: { sessionId: "s1", username: "alice" },
  });
  expect(res).toMatchObject({ result: { ok: true } });
  expect(chatStore.deleteSession).toHaveBeenCalledWith("s1", "alice");
});

it("session.delete:非 master(deleteSession 回 false)→ -32000 拒绝", async () => {
  vi.spyOn(chatStore, "deleteSession").mockResolvedValue(false);
  const res = (await handleRpc(graphHolder, {
    jsonrpc: "2.0", id: 21, method: "session.delete",
    params: { sessionId: "s1", username: "bob" },
  })) as { error?: { code: number } };
  expect(res.error?.code).toBe(-32000);
});

it("session.delete 缺 username 返回 -32602", async () => {
  const res = (await handleRpc(graphHolder, {
    jsonrpc: "2.0", id: 22, method: "session.delete",
    params: { sessionId: "s1" },
  })) as { error?: { code: number } };
  expect(res.error?.code).toBe(-32602);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/test/rpcServer.test.ts`
Expected: FAIL — 现 `session.delete` 不收 username、调 `deleteSession(sessionId)` 单参。

- [ ] **Step 3: 改 `session.delete` 分支**

`session.delete` 分支（374-385 行）替换为：

```ts
  // session.delete:删除会议(级联删消息)。仅会议发起者(master)可删;讨论进行中不允许删。
  if (body.method === "session.delete") {
    const sessionId = params.sessionId;
    const username = params.username;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    if (typeof username !== "string" || !username) {
      return rpcError(id, -32602, "缺少 username");
    }
    if (sessions.isBusy(sessionId)) {
      return rpcError(id, -32000, "该会话讨论进行中,无法删除");
    }
    const deleted = await chatStore.deleteSession(sessionId, username);
    if (!deleted) {
      return rpcError(id, -32000, "只有会议发起者可删除该会议");
    }
    return rpcOk(id, { ok: true });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/test/rpcServer.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/server/rpcServer.ts apps/runtime/src/server/test/rpcServer.test.ts
git commit -m "feat(meeting): session.delete 仅 master 可删"
```

---

## Task 13: RPC `twin.list` / `twin.getProfile` / `twin.setProfile`

**Files:**
- Modify: `apps/runtime/src/server/rpcServer.ts`（在 `user.setMemory` 分支之后、`chat.send` 之前插入三个新分支）
- Test: `apps/runtime/src/server/test/rpcServer.test.ts`

- [ ] **Step 1: 写失败测试**

补用例：

```ts
describe("twin.* RPC", () => {
  it("twin.list 返回全部分身", async () => {
    vi.spyOn(userStore, "listTwins").mockResolvedValue([
      { username: "architect", displayName: "架构师", isSeed: true },
      { username: "alice", displayName: "Alice 的分身", isSeed: false },
    ]);
    const res = await handleRpc(graphHolder, { jsonrpc: "2.0", id: 30, method: "twin.list", params: {} });
    expect(res).toMatchObject({ result: [{ username: "architect" }, { username: "alice" }] });
  });

  it("twin.getProfile 命中返回 displayName/persona/tools", async () => {
    vi.spyOn(userStore, "getTwinByUsername").mockResolvedValue({
      username: "alice", displayName: "Alice 的分身", persona: "后端老兵",
      tools: ["rag_search"], agentKey: "u7", isSeed: false,
    });
    const res = await handleRpc(graphHolder, {
      jsonrpc: "2.0", id: 31, method: "twin.getProfile", params: { username: "alice" },
    });
    expect(res).toMatchObject({ result: { displayName: "Alice 的分身", persona: "后端老兵", tools: ["rag_search"] } });
  });

  it("twin.getProfile 未知用户 → -32000", async () => {
    vi.spyOn(userStore, "getTwinByUsername").mockResolvedValue(null);
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0", id: 32, method: "twin.getProfile", params: { username: "ghost" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32000);
  });

  it("twin.setProfile 透传 patch 给 setProfile", async () => {
    vi.spyOn(userStore, "setProfile").mockResolvedValue(undefined);
    const res = await handleRpc(graphHolder, {
      jsonrpc: "2.0", id: 33, method: "twin.setProfile",
      params: { username: "alice", displayName: "新名", tools: ["rag_search", "Read"] },
    });
    expect(res).toMatchObject({ result: { ok: true } });
    expect(userStore.setProfile).toHaveBeenCalledWith("alice", { displayName: "新名", tools: ["rag_search", "Read"] });
  });

  it("twin.setProfile 缺 username → -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0", id: 34, method: "twin.setProfile", params: { displayName: "x" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/test/rpcServer.test.ts`
Expected: FAIL — 三个 method 未知，handleRpc 走最后的「未知方法」分支。

- [ ] **Step 3: 实现三个分支**

在 `rpcServer.ts` 的 `user.setMemory` 分支（约 107 行结束）之后插入：

```ts
  // twin.list:列出全部数字分身(给参与者选择器 / 个人页)。无需鉴权——只是名录。
  if (body.method === "twin.list") {
    const twins = await userStore.listTwins();
    return rpcOk(id, twins);
  }

  // twin.getProfile:取某分身的资料(displayName/persona/tools)。未知用户回 -32000。
  if (body.method === "twin.getProfile") {
    const username = params.username;
    if (typeof username !== "string" || !username) {
      return rpcError(id, -32602, "缺少 username");
    }
    const twin = await userStore.getTwinByUsername(username);
    if (!twin) {
      return rpcError(id, -32000, "分身不存在");
    }
    return rpcOk(id, { displayName: twin.displayName, persona: twin.persona, tools: twin.tools });
  }

  // twin.setProfile:个人页改资料,只更新传入的字段(displayName/persona/tools 任意子集)。
  if (body.method === "twin.setProfile") {
    const username = params.username;
    if (typeof username !== "string" || !username) {
      return rpcError(id, -32602, "缺少 username");
    }
    // 逐字段校验类型,只把合法字段放进 patch。
    const patch: { displayName?: string; persona?: string; tools?: string[] } = {};
    if (typeof params.displayName === "string") {
      patch.displayName = params.displayName;
    }
    if (typeof params.persona === "string") {
      patch.persona = params.persona;
    }
    if (Array.isArray(params.tools)) {
      const tools: string[] = [];
      for (const t of params.tools) {
        if (typeof t === "string" && t) {
          tools.push(t);
        }
      }
      patch.tools = tools;
    }
    await userStore.setProfile(username, patch);
    return rpcOk(id, { ok: true });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/test/rpcServer.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/runtime/src/server/rpcServer.ts apps/runtime/src/server/test/rpcServer.test.ts
git commit -m "feat(twin): 新增 twin.list/getProfile/setProfile RPC"
```

---

## Task 14: 全量验证（typecheck + 全测试套件 + 真库冒烟）

**Files:** 无新增改动；只验证。

- [ ] **Step 1: 全量类型检查**

Run: `pnpm --filter @meetmind/runtime typecheck`
Expected: 无错误。若报 `createSession`/`deleteSession`/`listSessions` 调用方类型不符——说明有未更新的调用点（除 rpcServer 外，检查 `cli/`、`server/runExecution.ts`、`server/sessions.ts` 是否调到这些函数）。`getSessionOwner` 仍读 owner、未改签名，runExecution 不受影响。

- [ ] **Step 2: 跑 runtime 全套单测**

Run: `pnpm --filter @meetmind/runtime test`
Expected: 全绿。重点确认 `chatStore`/`userStore`/`rpcServer`/`sessions`/`runExecution`/`meetingSummary` 测试都过。

- [ ] **Step 3: 真库冒烟（端到端 RPC，不经前端）**

确保 docker 起着（`docker compose up -d`）。启动 runtime：`pnpm --filter @meetmind/runtime dev`（另开一个终端）。然后：

```bash
# 注册一个分身
curl -s localhost:3002/api -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"user.registry","params":{"username":"alice","password":"pw","persona":"后端老兵","displayName":"Alice 的分身"}}'
# 列分身（应含 5 个种子 + admin + alice）
curl -s localhost:3002/api -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"twin.list","params":{}}'
# alice 建一个含 architect 的会议
curl -s localhost:3002/api -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"session.create","params":{"title":"登录页会议","username":"alice","participants":["architect"]}}'
# alice 的会议列表（应含上面那条，isMaster:true）
curl -s localhost:3002/api -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"session.list","params":{"username":"alice"}}'
# 非 master(architect)尝试删 → 应回 error -32000
#   （把 <SID> 换成上一步返回的 id）
curl -s localhost:3002/api -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"session.delete","params":{"sessionId":"<SID>","username":"architect"}}'
# master(alice)删 → ok
curl -s localhost:3002/api -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":6,"method":"session.delete","params":{"sessionId":"<SID>","username":"alice"}}'
```

Expected: 注册 ok；twin.list 含种子+alice；建会议返回 meta（master:"alice", participants:["architect"], isMaster:true）；architect 删被拒（error -32000）；alice 删成功（ok:true）。

> 注意：CLAUDE.md「容易踩的坑」——改了 `rpcServer.ts` 新增 method 后**必须重启 runtime 进程**，否则新 method 报「未知方法」。

- [ ] **Step 4: 提交（若 typecheck/测试触发了任何小修）**

```bash
git add -A
git commit -m "chore(twin): 第①期全量验证修整"
```

---

## Self-Review（写完计划后对照 spec 的自检结果）

**Spec 覆盖：**
- §4 三字段身份（id/agent_key/username/display_name）→ Task 1（列）+ Task 2（agent_key 分配）+ Task 4（种子 agent_key=角色名）✅
- §5.1 twins 表扩列 + 迁 5 角色 + admin 回填 → Task 1/2/4/5 ✅
- §5.2 sessions master/participants + 回填 + GIN + 列表过滤 + master-only 删 → Task 6/7/8/9 + Task 11/12 ✅
- §9 RPC：user.registry 收 persona/建表、session.create 收 participants、session.delete 鉴权、twin.list/getProfile/setProfile → Task 10/11/12/13 ✅
- §5.4 doc id 改 `<agent_key>_md5(filename+content)` → **第②期**（随知识上传）；本期不涉及，已在 plan 顶部「本期不做」标注 ✅
- §5.3 per-twin 记忆 / §6 动态图 / §7 工具绑定执行 / §8 上传 → **第②期**，本期明确不做 ✅

**占位符扫描：** 无 TBD/TODO；每个 code 步骤都给了完整代码与命令。`seedRoleTwins` 的 persona 文案为具体字符串（非占位）。✅

**类型一致性：**
- `createUser(username, password, persona, displayName?)` 返回 `RegisterResult{ok,reason?,agentKey?}`——Task 2 定义、Task 10 消费一致。✅
- `createSession(title, master, participants)` / `listSessions(username)` / `deleteSession(sessionId, requester):boolean`——Task 7/8/9 定义，Task 11/12 与 rpcServer.test mock（Task 11 Step 1 修形状）一致。✅
- `SessionMeta` 加 `master/participants/isMaster`——Task 7 定义，Task 8 产出、Task 11 mock 一致。✅
- `getTwinByUsername` 返回 `TwinProfile{username,displayName,persona,tools,agentKey,isSeed}`、`setProfile(username, {displayName?,persona?,tools?})`——Task 3 定义，Task 13 消费一致。✅

**已知风险（执行时留意）：**
- Task 10 给 `connection/client.js` 打 mock，若 `rpcServer.ts` 经它间接 import 了其它导出，mock 工厂要补齐（报错即补 `xxx: vi.fn()`）。
- Task 1 的 agent_key 唯一约束用 try/catch 吞重复——若库里已有重复 agent_key（理论上不会，因回填用 id）会被忽略；可接受。
