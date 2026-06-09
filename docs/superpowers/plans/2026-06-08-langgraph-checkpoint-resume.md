# LangGraph Checkpoint 断点续跑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ 本仓库约定：不自动 git commit / push / PR。** 计划里的每个「Checkpoint」步骤代表一个逻辑提交点，给出了建议 commit message，但**执行 agent 默认不要运行 `git commit`**——把变更留在工作区，等仓库主人明确要求再提交。

**Goal:** 给 MeetMind 的多 Agent 图接入 LangGraph PostgresSaver，使一轮讨论跑到一半时进程崩溃后，用户可手动点「继续」从最后一个节点的 checkpoint 续跑，不丢整轮。

**Architecture:** 编译图时挂 `PostgresSaver`（复用业务 PG）。每轮用唯一 `thread_id = sessionId:roundId`，轮开始时把它写进 `sessions.pending_thread_id` 列；正常完成 / 用户停止时清空并删 checkpoint。进程崩溃时该列残留 = 「可恢复」信号。前端打开会话时探测，弹「继续」按钮，点击后后端 `graph.stream(null, {thread_id})` 从 checkpoint 续跑，SSE 复用既有事件。

**Tech Stack:** TypeScript (ESM/NodeNext)、`@langchain/langgraph@0.2.74` + 新增 `@langchain/langgraph-checkpoint-postgres@^0.0.5`、PostgreSQL (`pg`)、Vitest、Vue 3 + Pinia。

**Spec:** `docs/superpowers/specs/2026-06-08-langgraph-checkpoint-resume-design.md`

---

## 文件结构

**新建：**
- `apps/runtime/src/graph/checkpointer.ts` — PostgresSaver 单例 `getCheckpointer()` + best-effort 清理 `deleteThreadCheckpoints()`
- `apps/runtime/src/graph/test/checkpointer.test.ts` — 清理函数单测

**修改：**
- `apps/runtime/package.json` — 加依赖
- `apps/runtime/src/database/chat/chatStore.ts` — `pending_thread_id` 列 + 三个读写函数
- `apps/runtime/src/database/chat/test/chatStore.test.ts` — 新函数单测
- `apps/runtime/src/bootstrap.ts` — 启动 `setup()` 建 checkpoint 表
- `apps/runtime/src/graph/builder.ts` — `compile({ checkpointer })`
- `apps/runtime/src/cli/main.ts` — stream 补 `thread_id`
- `apps/runtime/src/server/runExecution.ts` — 轮内写/清 marker + 新增 `resumeExecution()`
- `apps/runtime/src/server/rpcServer.ts` — `chat.getResumable` + `chat.resume`
- `apps/desktop/src/stores/chat.ts` — `resumable` 状态 + 动作
- `apps/desktop/src/stores/test/chat.test.ts` — 新动作单测
- `apps/desktop/src/components/ChatWindow.vue` — 探测 + 「继续」提示条

---

## Task 1: 新增 checkpoint-postgres 依赖

**Files:**
- Modify: `apps/runtime/package.json`

- [ ] **Step 1: 安装依赖**

Run:
```bash
pnpm --filter @meetmind/runtime add @langchain/langgraph-checkpoint-postgres@^0.0.5
```

- [ ] **Step 2: 验证可导入且导出 PostgresSaver**

Run:
```bash
cd /Users/chenlv/Project/MeetMind && node -e "import('@langchain/langgraph-checkpoint-postgres').then(m => console.log('exports:', Object.keys(m).join(',')))"
```
Expected: 输出包含 `PostgresSaver`。

- [ ] **Step 3: Checkpoint（不自动提交）**

建议 message：`chore(runtime): add @langchain/langgraph-checkpoint-postgres`

---

## Task 2: chatStore 增加 `pending_thread_id` 列与读写函数

**Files:**
- Modify: `apps/runtime/src/database/chat/chatStore.ts`
- Test: `apps/runtime/src/database/chat/test/chatStore.test.ts`

- [ ] **Step 1: 先写失败测试**

在 `apps/runtime/src/database/chat/test/chatStore.test.ts` 的 import 列表里加上新函数，并在文件末尾追加测试。

把 import 块（第 15-26 行）改成包含新函数：
```ts
import {
  ensureChatTables,
  createSession,
  listSessions,
  getSessionOwner,
  getMessages,
  appendMessages,
  renameSession,
  deleteSession,
  markSessionEnded,
  isSessionEnded,
  setPendingThread,
  clearPendingThread,
  getPendingThread,
} from "../chatStore.js";
```

在文件末尾追加：
```ts
describe("pending_thread_id（断点续跑标记）", () => {
  it("ensureChatTables 幂等补 pending_thread_id 列", async () => {
    await ensureChatTables();
    const sqls: string[] = [];
    for (const call of mockQuery.mock.calls) {
      sqls.push(String(call[0]));
    }
    const joined = sqls.join("\n");
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS pending_thread_id TEXT");
  });

  it("setPendingThread 发 UPDATE 写入 thread_id", async () => {
    await setPendingThread("s1", "s1:r1");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("UPDATE meetmind_sessions SET pending_thread_id = $2");
    expect(String(sql)).toContain("WHERE id = $1");
    expect(params).toEqual(["s1", "s1:r1"]);
  });

  it("clearPendingThread 发 UPDATE 置 NULL", async () => {
    await clearPendingThread("s1");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("SET pending_thread_id = NULL");
    expect(params).toEqual(["s1"]);
  });

  it("getPendingThread 命中时回 thread_id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ pending_thread_id: "s1:r1" }] });
    expect(await getPendingThread("s1")).toBe("s1:r1");
  });

  it("getPendingThread 无行 / 为 NULL → 回 null", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getPendingThread("ghost")).toBe(null);
    mockQuery.mockResolvedValueOnce({ rows: [{ pending_thread_id: null }] });
    expect(await getPendingThread("s2")).toBe(null);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
pnpm --filter @meetmind/runtime exec vitest run src/database/chat/test/chatStore.test.ts
```
Expected: FAIL，报 `setPendingThread`/`clearPendingThread`/`getPendingThread` is not a function 及缺列断言不通过。

- [ ] **Step 3: 实现列与函数**

在 `apps/runtime/src/database/chat/chatStore.ts` 的 `ensureChatTables()` 里，紧跟现有 owner 列迁移（约第 62 行 `ALTER COLUMN owner DROP DEFAULT` 之后）加一行：
```ts
  // 断点续跑：本会话当前在途轮次的 LangGraph thread_id（非空=有未收尾的轮，可恢复）。
  await pool.query(`ALTER TABLE ${sessions} ADD COLUMN IF NOT EXISTS pending_thread_id TEXT`);
```

在文件末尾（`deleteSession` 之后）追加三个函数：
```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
pnpm --filter @meetmind/runtime exec vitest run src/database/chat/test/chatStore.test.ts
```
Expected: PASS（含原有用例）。

- [ ] **Step 5: Checkpoint（不自动提交）**

建议 message：`feat(runtime): add pending_thread_id column + accessors to chatStore`

---

## Task 3: checkpointer 单例模块 + 清理函数

**Files:**
- Create: `apps/runtime/src/graph/checkpointer.ts`
- Test: `apps/runtime/src/graph/test/checkpointer.test.ts`

- [ ] **Step 1: 先写失败测试**

Create `apps/runtime/src/graph/test/checkpointer.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// 只验证清理函数拼的 SQL；pg 池打桩，不连真库、不实例化 PostgresSaver。
const mockQuery = vi.hoisted(() => vi.fn());
vi.mock("../../database/connection/client.js", () => ({
  getPgPool: () => ({ query: mockQuery }),
}));
vi.mock("../../config/settings.js", () => ({
  getSettings: () => ({ pgUrl: "postgresql://x/y" }),
}));

import { deleteThreadCheckpoints } from "../checkpointer.js";

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("deleteThreadCheckpoints", () => {
  it("对三张 checkpoint 表各发一条按 thread_id 的 DELETE", async () => {
    await deleteThreadCheckpoints("s1:r1");
    expect(mockQuery).toHaveBeenCalledTimes(3);
    const joined = mockQuery.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("DELETE FROM checkpoints WHERE thread_id = $1");
    expect(joined).toContain("DELETE FROM checkpoint_blobs WHERE thread_id = $1");
    expect(joined).toContain("DELETE FROM checkpoint_writes WHERE thread_id = $1");
    for (const call of mockQuery.mock.calls) {
      expect(call[1]).toEqual(["s1:r1"]);
    }
  });

  it("某条 DELETE 抛错时吞掉异常、不向上抛", async () => {
    mockQuery.mockRejectedValueOnce(new Error("boom"));
    await expect(deleteThreadCheckpoints("s1:r1")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
pnpm --filter @meetmind/runtime exec vitest run src/graph/test/checkpointer.test.ts
```
Expected: FAIL，报无法解析 `../checkpointer.js`。

- [ ] **Step 3: 实现 checkpointer 模块**

Create `apps/runtime/src/graph/checkpointer.ts`:
```ts
/**
 * LangGraph checkpointer 单例（PostgresSaver）。
 *
 * 复用业务库 PG_URL 落 checkpoint（库自管表 checkpoints* 与 meetmind_* 业务表并存）。
 * 单例：model.set 触发 buildGraph() 重建图时复用同一 saver，才能读到崩溃前写下的 checkpoint。
 */
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { getSettings } from "../config/settings.js";
import { getPgPool } from "../database/connection/client.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("graph.checkpointer");

let _saver: PostgresSaver | null = null;

/** 进程内单例 PostgresSaver。bootstrap 里取它跑一次 .setup() 建表。 */
export function getCheckpointer(): PostgresSaver {
  if (_saver !== null) {
    return _saver;
  }
  const settings = getSettings();
  _saver = PostgresSaver.fromConnString(settings.pgUrl);
  return _saver;
}

// PostgresSaver 自管的表名（用于 best-effort 清理；建表由 setup() 完成）。
// 删序无所谓：均按 thread_id 过滤，互不依赖。
const CHECKPOINT_TABLES = ["checkpoint_writes", "checkpoint_blobs", "checkpoints"];

/**
 * best-effort 删除某 thread 的全部 checkpoint 行。
 * 全程 try/catch：删失败只 log warn，绝不影响调用方（轮次成败与清理解耦）。
 * 注：该版 PostgresSaver 无 deleteThread()，故走业务 pool 直接 DELETE。
 */
export async function deleteThreadCheckpoints(threadId: string): Promise<void> {
  try {
    const pool = getPgPool();
    for (const table of CHECKPOINT_TABLES) {
      await pool.query(`DELETE FROM ${table} WHERE thread_id = $1`, [threadId]);
    }
  } catch (exc) {
    logger.warning(`[checkpointer] 清理 thread ${threadId} 的 checkpoint 失败（已忽略）: ${String(exc)}`);
  }
}
```

> 注：`getLogger(...).warning(...)` 与 `database/connection/client.ts` 同款用法。

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
pnpm --filter @meetmind/runtime exec vitest run src/graph/test/checkpointer.test.ts
```
Expected: PASS。

- [ ] **Step 5: Checkpoint（不自动提交）**

建议 message：`feat(runtime): add PostgresSaver checkpointer singleton + thread cleanup`

---

## Task 4: bootstrap 启动建 checkpoint 表

**Files:**
- Modify: `apps/runtime/src/bootstrap.ts`

- [ ] **Step 1: 加 import**

在 import 区（约第 22 行 `initMcpTools` 那行附近）加：
```ts
import { getCheckpointer } from "./graph/checkpointer.js";
```

- [ ] **Step 2: 在会话表就绪后调 setup()**

在 `ensureChatTables()` 那段之后（约第 60 行 `printSystem(chalk.green("✓ 会话 / 消息表已就绪"));` 之下）插入：
```ts
  // ---------- LangGraph checkpoint 表（断点续跑）----------
  await getCheckpointer().setup();
  printSystem(chalk.green("✓ LangGraph checkpoint 表已就绪（断点续跑）"));
```

- [ ] **Step 3: 类型检查通过**

Run:
```bash
pnpm --filter @meetmind/runtime typecheck
```
Expected: 无错误。

- [ ] **Step 4: Checkpoint（不自动提交）**

建议 message：`feat(runtime): run checkpointer.setup() during bootstrap`

---

## Task 5: 编译图时挂 checkpointer

**Files:**
- Modify: `apps/runtime/src/graph/builder.ts`

- [ ] **Step 1: 加 import**

在 import 区（约第 31-33 行那几个 preprocess/route import 附近）加：
```ts
import { getCheckpointer } from "./checkpointer.js";
```

- [ ] **Step 2: 放宽 compile 的 cast 类型并传入 checkpointer**

把 `buildGraph()` 里 `graph` 强转对象（约第 199-208 行）中的 `compile` 一行：
```ts
    compile: () => ReturnType<StateGraph<typeof AgentStateAnnotation.spec>["compile"]>;
```
改成：
```ts
    compile: (options?: { checkpointer?: unknown }) => ReturnType<StateGraph<typeof AgentStateAnnotation.spec>["compile"]>;
```

把第 240 行：
```ts
  const compiled = graph.compile();
```
改成：
```ts
  const compiled = graph.compile({ checkpointer: getCheckpointer() });
```

- [ ] **Step 3: 类型检查通过**

Run:
```bash
pnpm --filter @meetmind/runtime typecheck
```
Expected: 无错误。

- [ ] **Step 4: Checkpoint（不自动提交）**

建议 message：`feat(runtime): compile graph with PostgresSaver checkpointer`

---

## Task 6: CLI stream 补 thread_id

**Files:**
- Modify: `apps/runtime/src/cli/main.ts`

> 编译带 checkpointer 后，所有 `stream()` 必须带 `configurable.thread_id`，否则运行时报错。CLI 不做恢复 UI，只补一个一次性 id。

- [ ] **Step 1: stream 调用补 thread_id**

把 `cli/main.ts` 本地 `runExecution` 里（约第 74-77 行）：
```ts
  const stream = await graph.stream(initialState, {
    recursionLimit: 50, // 防失控的硬上限
    streamMode: "values",
  });
```
改成：
```ts
  // 编译带 checkpointer 后必须带 thread_id；CLI 每轮用一次性 id，不做恢复。
  const threadId = `cli:${Date.now()}`;
  const stream = await graph.stream(initialState, {
    recursionLimit: 50, // 防失控的硬上限
    streamMode: "values",
    configurable: { thread_id: threadId },
  });
```

- [ ] **Step 2: 类型检查通过**

Run:
```bash
pnpm --filter @meetmind/runtime typecheck
```
Expected: 无错误。

- [ ] **Step 3: Checkpoint（不自动提交）**

建议 message：`fix(runtime): pass thread_id in CLI stream (checkpointer requires it)`

---

## Task 7: runExecution 写/清 in-flight 标记 + thread_id

**Files:**
- Modify: `apps/runtime/src/server/runExecution.ts`

- [ ] **Step 1: 加 import**

在 import 区顶部加：
```ts
import { randomUUID } from "node:crypto";
```
在现有 import 里加（约第 10 行 `buildGraph` 类型 import 附近）：
```ts
import { deleteThreadCheckpoints } from "../graph/checkpointer.js";
```

- [ ] **Step 2: 在 try 之前生成 threadId + 定义清理闭包**

把函数体里 `userTurn` 定义之后、`try {` 之前，插入：
```ts
  // 本轮唯一 thread_id；清理闭包供「完成 / 停止 / 出错」三处复用（崩溃则都不跑→标记残留）。
  const roundId = randomUUID();
  const threadId = `${sessionId}:${roundId}`;
  async function cleanupRound(): Promise<void> {
    await chatStore.clearPendingThread(sessionId);
    await deleteThreadCheckpoints(threadId);
  }
```

- [ ] **Step 3: try 内、stream 之前写标记 + stream 带 thread_id**

在 `try {` 之后、`const priorMessages = ...` 之前插入：
```ts
    // 轮开始即登记在途 thread_id：崩溃时该标记残留 = 可恢复信号。
    await chatStore.setPendingThread(sessionId, threadId);
```

把 `graph.stream(initialState, {...})`（约第 65-69 行）改成带 `configurable`：
```ts
    const stream = await graph.stream(initialState, {
      recursionLimit: 50,
      streamMode: ["custom", "values"],
      signal,
      configurable: { thread_id: threadId },
    });
```

- [ ] **Step 4: 三个收尾分支加清理**

把「被打断（try 内 `if (signal?.aborted)`）」分支改成先清理：
```ts
    if (signal?.aborted) {
      logger.info(`[runExecution] 会话 ${sessionId} 被用户打断,本轮不落库`);
      await cleanupRound();
      sseServer.send(sessionId, "round_done", { done: false, interrupted: true });
      return;
    }
```

把正常完成段（`appendMessages` 之后）改成：
```ts
    await chatStore.appendMessages(sessionId, newTurns);
    await cleanupRound();
    sseServer.send(sessionId, "round_done", { done: finalState.done ?? false });
```

把 catch 里两处也加清理：
```ts
  } catch (exc) {
    if (signal?.aborted) {
      logger.info(`[runExecution] 会话 ${sessionId} 被用户打断(stream 抛出),本轮不落库`);
      await cleanupRound();
      sseServer.send(sessionId, "round_done", { done: false, interrupted: true });
      return;
    }
    logger.error(`[runExecution] 会话 ${sessionId} 出错: ${String(exc)}`);
    await cleanupRound();
    sseServer.send(sessionId, "error", { message: String(exc) });
  }
```

> 设计意图：只有真正的进程崩溃才会让 `cleanupRound` 一次都跑不到、标记残留；被用户打断 / 普通报错都属「进程还活着、本轮作废」，清掉标记不让它被误当作可恢复。

- [ ] **Step 5: 类型检查通过**

Run:
```bash
pnpm --filter @meetmind/runtime typecheck
```
Expected: 无错误。

- [ ] **Step 6: Checkpoint（不自动提交）**

建议 message：`feat(runtime): track in-flight thread_id per round in runExecution`

---

## Task 8: 新增 resumeExecution

**Files:**
- Modify: `apps/runtime/src/server/runExecution.ts`

- [ ] **Step 1: 在文件末尾追加 resumeExecution**

```ts
/**
 * 从崩溃残留的 checkpoint 续跑某会话的未完成轮：
 *   读 pending thread_id → graph.stream(null, {thread_id}) 从最后一个节点续 →
 *   SSE 复用既有事件 → 增量落库 → 清标记 / 删 checkpoint → round_done。
 */
export async function resumeExecution(
  graph: CompiledGraph,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const threadId = await chatStore.getPendingThread(sessionId);
    if (!threadId) {
      // 没有可恢复轮：直接发 round_done 让前端复位。
      sseServer.send(sessionId, "round_done", { done: false });
      return;
    }
    // 崩溃轮从未落库，当前 DB 条数 == 该轮开始时的基线。
    const priorMessages = await chatStore.getMessages(sessionId);
    const priorCount = priorMessages.length;

    let finalState: AgentState | null = null;
    // 传 null 输入 = 从最后一个 checkpoint 续跑；只重跑崩溃时未完成的节点及其后续。
    const stream = await graph.stream(null, {
      recursionLimit: 50,
      streamMode: ["custom", "values"],
      signal,
      configurable: { thread_id: threadId },
    });
    for await (const item of stream) {
      const [mode, chunk] = item as [string, unknown];
      if (mode === "custom") {
        const event = chunk as NodeStreamChunk;
        sseServer.send(sessionId, event.kind, event);
      } else {
        finalState = chunk as AgentState;
      }
    }

    // 恢复中被打断：丢弃这次恢复，清标记不再续。
    if (signal?.aborted) {
      logger.info(`[resumeExecution] 会话 ${sessionId} 恢复中被打断`);
      await chatStore.clearPendingThread(sessionId);
      await deleteThreadCheckpoints(threadId);
      sseServer.send(sessionId, "round_done", { done: false, interrupted: true });
      return;
    }

    const finalMessages = finalState?.messages ?? priorMessages;
    const newTurns = finalMessages.slice(priorCount);
    await chatStore.appendMessages(sessionId, newTurns);
    await chatStore.clearPendingThread(sessionId);
    await deleteThreadCheckpoints(threadId);
    sseServer.send(sessionId, "round_done", { done: finalState?.done ?? false });
  } catch (exc) {
    if (signal?.aborted) {
      logger.info(`[resumeExecution] 会话 ${sessionId} 恢复中被打断(stream 抛出)`);
      const tid = await chatStore.getPendingThread(sessionId);
      await chatStore.clearPendingThread(sessionId);
      if (tid) {
        await deleteThreadCheckpoints(tid);
      }
      sseServer.send(sessionId, "round_done", { done: false, interrupted: true });
      return;
    }
    // 非打断的恢复错误：保留 pending 标记，允许用户再次点「继续」重试。
    logger.error(`[resumeExecution] 会话 ${sessionId} 恢复出错: ${String(exc)}`);
    sseServer.send(sessionId, "error", { message: String(exc) });
  }
}
```

> 若 `graph.stream(null, ...)` 处 TS 报 input 类型不接受 null，改为 `graph.stream(null as unknown as Parameters<typeof graph.stream>[0], {...})`。

- [ ] **Step 2: 类型检查通过**

Run:
```bash
pnpm --filter @meetmind/runtime typecheck
```
Expected: 无错误。

- [ ] **Step 3: Checkpoint（不自动提交）**

建议 message：`feat(runtime): add resumeExecution to continue from checkpoint`

---

## Task 9: RPC 增加 chat.getResumable + chat.resume

**Files:**
- Modify: `apps/runtime/src/server/rpcServer.ts`

- [ ] **Step 1: 调整 import**

把第 5 行：
```ts
import { runExecution } from "./runExecution.js";
```
改成：
```ts
import { runExecution, resumeExecution } from "./runExecution.js";
```
并加：
```ts
import type { AgentState } from "../graph/state.js";
```

- [ ] **Step 2: 在 chat.interrupt 处理块之后插入两个新 method**

在 `chat.interrupt`（约第 155 行 `}` 结束）之后插入：
```ts
  // chat.getResumable:探测本会话是否有崩溃残留的未完成轮可恢复。
  if (body.method === "chat.getResumable") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    // 正在跑就不提示恢复。
    if (sessions.isBusy(sessionId)) {
      return rpcOk(id, { resumable: false });
    }
    const threadId = await chatStore.getPendingThread(sessionId);
    if (!threadId) {
      return rpcOk(id, { resumable: false });
    }
    // 取 checkpoint 当前状态里「超出 DB」的发言，供前端先渲染崩溃前内容。
    let pendingTurns: unknown[] = [];
    try {
      const snapshot = await graph.current.getState({ configurable: { thread_id: threadId } });
      const stateValues = snapshot?.values as AgentState | undefined;
      const checkpointMessages = stateValues?.messages ?? [];
      const dbMessages = await chatStore.getMessages(sessionId);
      pendingTurns = checkpointMessages.slice(dbMessages.length);
    } catch (exc) {
      console.error(`[rpc] getResumable 读取 checkpoint 失败 (会话 ${sessionId}):`, exc);
      return rpcOk(id, { resumable: false });
    }
    if (pendingTurns.length === 0) {
      return rpcOk(id, { resumable: false });
    }
    return rpcOk(id, { resumable: true, pendingTurns });
  }

  // chat.resume:从崩溃残留的 checkpoint 续跑未完成轮（仿 chat.send 不 await）。
  if (body.method === "chat.resume") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    if (await chatStore.isSessionEnded(sessionId)) {
      return rpcError(id, -32000, "会议已结束,无法继续讨论");
    }
    if (sessions.isBusy(sessionId)) {
      return rpcError(id, -32000, "上一轮讨论还在进行");
    }
    const threadId = await chatStore.getPendingThread(sessionId);
    if (!threadId) {
      return rpcError(id, -32000, "没有可恢复的未完成轮次");
    }
    sessions.setBusy(sessionId, true);
    const controller = new AbortController();
    sessions.setController(sessionId, controller);
    const running = resumeExecution(graph.current, sessionId, controller.signal);
    running
      .catch((exc) => {
        console.error(`[rpc] resumeExecution 未捕获异常 (会话 ${sessionId}):`, exc);
      })
      .finally(() => {
        sessions.setBusy(sessionId, false);
        sessions.clearController(sessionId);
      });
    return rpcOk(id, { ok: true });
  }
```

- [ ] **Step 3: 类型检查通过**

Run:
```bash
pnpm --filter @meetmind/runtime typecheck
```
Expected: 无错误。

- [ ] **Step 4: Checkpoint（不自动提交）**

建议 message：`feat(runtime): add chat.getResumable + chat.resume RPC methods`

---

## Task 10: 前端 chat store 的 resumable 状态与动作

**Files:**
- Modify: `apps/desktop/src/stores/chat.ts`
- Test: `apps/desktop/src/stores/test/chat.test.ts`

- [ ] **Step 1: 先写失败测试**

在 `apps/desktop/src/stores/test/chat.test.ts` 末尾追加：
```ts
describe("chat store — 断点续跑", () => {
  it("setResumable 追加崩溃前发言并置 resumable", () => {
    const chat = useChatStore();
    chat.addUser("s1", "做个登录页");
    chat.setResumable("s1", [
      { agent_name: "architect", role: "架构师", message: "我来分配", next_agent: "backend", done: false, used_rag: false, tool: "" },
    ]);
    const bubbles = chat.bubblesOf("s1");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[1]).toMatchObject({ agent_name: "architect", text: "我来分配", turnEnded: true, isUser: false });
    expect(chat.isResumable("s1")).toBe(true);
  });

  it("clearResumable 复位 resumable", () => {
    const chat = useChatStore();
    chat.setResumable("s1", [
      { agent_name: "architect", role: "架构师", message: "x", next_agent: null, done: false, used_rag: false, tool: "" },
    ]);
    chat.clearResumable("s1");
    expect(chat.isResumable("s1")).toBe(false);
  });

  it("beginResume 置 busy 且清 resumable", () => {
    const chat = useChatStore();
    chat.setResumable("s1", [
      { agent_name: "architect", role: "架构师", message: "x", next_agent: null, done: false, used_rag: false, tool: "" },
    ]);
    chat.beginResume("s1");
    expect(chat.isBusy("s1")).toBe(true);
    expect(chat.isResumable("s1")).toBe(false);
  });

  it("drop 一并清掉 resumable", () => {
    const chat = useChatStore();
    chat.setResumable("s1", [
      { agent_name: "architect", role: "架构师", message: "x", next_agent: null, done: false, used_rag: false, tool: "" },
    ]);
    chat.drop("s1");
    expect(chat.isResumable("s1")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
pnpm --filter @meetmind/desktop exec vitest run src/stores/test/chat.test.ts
```
Expected: FAIL，报 `setResumable`/`isResumable`/`clearResumable`/`beginResume` 不存在。

- [ ] **Step 3: 实现状态与动作**

在 `apps/desktop/src/stores/chat.ts` 的 `ChatState` 接口里加一行（紧跟 `pendingApprovalBySession`）：
```ts
  // 各会话是否有崩溃残留的未完成轮可恢复（探测得到后置位；点「继续」/落定后清）。
  resumableBySession: Record<string, boolean>;
```

在 `state` 初值里加（紧跟 `pendingApprovalBySession: {}`）：
```ts
    resumableBySession: {},
```

在 `getters` 里加（紧跟 `pendingApprovalOf`）：
```ts
    isResumable: (state) => (sessionId: string) => state.resumableBySession[sessionId] ?? false,
```

在 `actions` 里加（紧跟 `clearPendingApproval` 之后）：
```ts
    /** 探测到可恢复轮：把崩溃前已产出的发言作为已落定气泡追加，并置 resumable。 */
    setResumable(sessionId: string, turns: StoredTurn[]): void {
      this.ensure(sessionId);
      const bubbles = this.bubblesBySession[sessionId];
      const base = bubbles.length;
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        let createdAt = Date.now();
        if (t.created_at) {
          const parsed = new Date(t.created_at).getTime();
          if (!Number.isNaN(parsed)) {
            createdAt = parsed;
          }
        }
        bubbles.push({
          turnId: `resume-${base + i}`,
          agent_name: t.agent_name,
          role: t.role,
          text: t.message,
          isUser: t.agent_name === "user",
          done: t.done,
          used_rag: t.used_rag,
          tool: t.tool ?? "",
          toolCalls: t.tool_calls ?? [],
          createdAt,
          turnEnded: true,
        });
      }
      this.resumableBySession[sessionId] = true;
    },
    /** 清除某会话的 resumable 标记（提示条消失）。 */
    clearResumable(sessionId: string): void {
      this.resumableBySession[sessionId] = false;
    },
    /** 点「继续」：置 busy 并清 resumable，随后由 SSE 流式补完本轮。 */
    beginResume(sessionId: string): void {
      this.busyBySession[sessionId] = true;
      this.resumableBySession[sessionId] = false;
    },
```

在 `drop(sessionId)` 里加一行（与其它 delete 并列）：
```ts
      delete this.resumableBySession[sessionId];
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
pnpm --filter @meetmind/desktop exec vitest run src/stores/test/chat.test.ts
```
Expected: PASS（含原有用例）。

- [ ] **Step 5: Checkpoint（不自动提交）**

建议 message：`feat(desktop): add resumable state + actions to chat store`

---

## Task 11: 前端 ChatWindow 探测 + 「继续」提示条

**Files:**
- Modify: `apps/desktop/src/components/ChatWindow.vue`

- [ ] **Step 1: 加 computed + 探测/恢复函数**

在 `<script setup>` 里，`pendingApproval` 那个 computed（约第 39 行）之后加：
```ts
// 是否有崩溃残留的未完成轮可恢复（探测后由 chat store 置位）。
const resumable = computed(() => chat.isResumable(props.sessionId));
```

在 `loadHistory` 函数之后加探测函数：
```ts
// 打开会话时探测是否有可恢复的未完成轮；有则把崩溃前发言渲染出来并弹「继续」。
async function checkResumable(sessionId: string): Promise<void> {
  if (!sessionId || chat.isBusy(sessionId) || chat.isEnded(sessionId)) {
    return;
  }
  try {
    const res = await rpc<{ resumable: boolean; pendingTurns?: StoredTurn[] }>(
      "chat.getResumable",
      { sessionId },
    );
    if (res.resumable && res.pendingTurns && res.pendingTurns.length > 0) {
      chat.setResumable(sessionId, res.pendingTurns);
    }
  } catch {
    // 探测失败静默忽略，不影响正常使用。
  }
}
```

- [ ] **Step 2: 在切换会话的 watch 里串行调用（load 完再探测）**

把 `watch(() => props.sessionId, ...)`（约第 63-74 行）的回调改成先 `await loadHistory` 再 `checkResumable`：
```ts
watch(
  () => props.sessionId,
  async (id) => {
    chat.ensure(id);
    // 先 load（会整体替换气泡），再探测续跑（在其后追加崩溃前发言），顺序不能反。
    await loadHistory(id);
    await checkResumable(id);
    await nextTick();
    composer.value?.focus();
  },
  { immediate: true },
);
```

- [ ] **Step 3: 加 onResume 处理函数**

在 `onInterrupt` 之后加：
```ts
// 点「继续」：从崩溃残留的 checkpoint 续跑未完成轮（发言经既有 SSE 流式进来）。
async function onResume(): Promise<void> {
  logUserAction("继续未完成轮次", { sessionId: props.sessionId });
  chat.beginResume(props.sessionId);
  try {
    await rpc("chat.resume", { sessionId: props.sessionId });
  } catch (e) {
    chat.addErrorBubble(props.sessionId, String(e));
  }
}
```

- [ ] **Step 4: 模板加提示条**

在 `<ToolApprovalBar ... />`（约第 173-178 行）之前插入：
```html
    <div v-if="resumable && !busy && !ended" class="resume-bar">
      <span class="resume-text">上一轮讨论未完成（可能因服务重启中断），是否继续？</span>
      <button class="resume-btn" @click="onResume">继续</button>
    </div>
```

在 `<style scoped>` 末尾加：
```css
.resume-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; background: var(--accent-soft); border-top: 1px solid var(--border); }
.resume-text { font-size: 13px; color: var(--text-main); }
.resume-btn { flex-shrink: 0; padding: 6px 14px; border: none; border-radius: 8px; background: var(--accent); color: #fff; font-size: 13px; cursor: pointer; }
.resume-btn:hover { opacity: 0.9; }
```

- [ ] **Step 5: 类型检查通过**

Run:
```bash
pnpm --filter @meetmind/desktop typecheck
```
Expected: 无错误。

- [ ] **Step 6: Checkpoint（不自动提交）**

建议 message：`feat(desktop): show resume prompt + wire chat.resume in ChatWindow`

---

## Task 12: 端到端崩溃恢复验证（手动）

**Files:** 无（验证）

- [ ] **Step 1: 全量测试 + 类型检查**

Run:
```bash
pnpm -r test && pnpm -r typecheck
```
Expected: 全部 PASS / 无类型错误。

- [ ] **Step 2: 起服务**

确保 `docker compose up -d` 已起 PG。两个终端分别：
```bash
pnpm dev:runtime   # 3002
pnpm dev:desktop   # 5173
```
浏览器开 `http://localhost:5173`，登录（admin/admin），新建会话。

- [ ] **Step 3: 制造崩溃**

在会话里发一条需求，等架构师 / 后端开始发言（讨论进行中）时，到 runtime 终端按 `Ctrl+C` **直接杀进程**（模拟崩溃）。

- [ ] **Step 4: 验证 DB 残留标记**

Run:
```bash
docker compose exec -T postgres psql -U meetmind -d meetmind -c "SELECT id, pending_thread_id FROM meetmind_sessions WHERE pending_thread_id IS NOT NULL;"
```
Expected: 该会话有一行，`pending_thread_id` 形如 `<sessionId>:<uuid>`。

- [ ] **Step 5: 重启 + 恢复**

重新 `pnpm dev:runtime`。浏览器刷新 / 重新打开该会话：
- Expected: 渲染出崩溃前已产出的发言（架构师/后端），输入框上方出现「上一轮讨论未完成…[继续]」。
- 点「继续」：后续 agent 发言流式补完，本轮以 `round_done` 收尾。

- [ ] **Step 6: 验证落库且无重复 + 标记已清**

刷新页面重新加载该会话历史：
- Expected: 整轮（用户输入 + 全部 agent 发言）完整、无重复。

Run:
```bash
docker compose exec -T postgres psql -U meetmind -d meetmind -c "SELECT id, pending_thread_id FROM meetmind_sessions WHERE id = '<上面的 sessionId>';"
```
Expected: `pending_thread_id` 为 NULL（已清）。

- [ ] **Step 7: 反向验证「停止 = 丢弃，不可恢复」**

再发一条需求，进行中点前端「打断」。
- Expected: 本轮丢弃；不出现「继续」提示条；DB 中该会话 `pending_thread_id` 为 NULL。

- [ ] **Step 8: Checkpoint（不自动提交）**

建议 message：`test: verify end-to-end checkpoint resume flow`（仅当本任务产生了可提交的脚本/文档变更时）

---

## Self-Review 结论

- **Spec 覆盖**：依赖(Task1)/单例+清理(Task3)/setup(Task4)/compile(Task5)/CLI thread_id(Task6)/thread_id+marker(Task2,7)/resumeExecution(Task8)/两 RPC(Task9)/前端 store(Task10)+UI(Task11)/验收(Task12) —— spec 各节均有对应任务。
- **类型/命名一致**：`getCheckpointer`/`deleteThreadCheckpoints`/`setPendingThread`/`clearPendingThread`/`getPendingThread`/`resumeExecution`/`setResumable`/`clearResumable`/`beginResume`/`isResumable` 在定义与调用处拼写一致；RPC 名 `chat.getResumable`/`chat.resume` 前后一致。
- **无占位**：每步含可直接落地的代码与命令。
