# 设计：基于 LangGraph PostgresSaver 的崩溃断点续跑

> 状态：待评审
> 日期：2026-06-08
> 范围：`apps/runtime`（后端）+ `apps/desktop`（前端）整套

## 1. 目标与非目标

### 目标
- 一轮多 Agent 讨论跑到一半时**进程崩溃 / 被杀**，重启后该轮**不丢弃**，可由用户**手动点「继续」**从最后一个 checkpoint 续跑。
- 复用现有 PostgreSQL 基础设施落 checkpoint，与「全走 PG」的项目哲学一致。

### 非目标（明确不做）
- **逐工具调用级恢复**：LangGraph checkpoint 粒度是「每个图节点跑完一帧」，不是「每次 LLM/工具调用一帧」。崩在某 agent 的 Phase 1 工具循环中途，最多丢这一个节点的半截工作，恢复时**重跑该节点**。
- **用户手动「停止」的轮次变成可续**：维持现状——手动停止 = 故意丢弃，不可恢复。只有崩溃/进程死才可恢复。
- **自动恢复**：重启后 runtime 不主动做事；恢复完全由用户点「继续」触发。
- CLI 的恢复 UI：CLI 只补 `thread_id` 满足编译要求，不做恢复交互。

## 2. 关键背景（现状约束）

- 当前每轮是一次**全新** `graph.stream(initialState)`，图跨轮无状态；跨轮记忆靠 `chatStore` 每轮从 PG 取历史 seed 进图、轮末增量落库（`apps/runtime/src/server/runExecution.ts`）。
- 被打断的轮次**故意不落库**（`runExecution.ts` `signal.aborted` 分支）。
- 同一会话靠内存态 `sessions.isBusy` 串行化，一次只跑一轮（`apps/runtime/src/server/sessions.ts`）。`isBusy` 是进程内存，崩溃后自然重置为 false。
- 图入口：`START → rewrite_node → intent_node → architect_node → (条件边) …`（`apps/runtime/src/graph/builder.ts`）。
- `chatStore` 已有 `sessions` / `messages` 两表，`ensureChatTables()` 用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 做幂等迁移（`apps/runtime/src/database/chat/chatStore.ts`）。
- 前端 SSE 事件（turn_start/delta/turn_end/round_done 等）在 `apps/desktop/src/App.vue` 全局订阅并打进 `chat` store；会话打开/切换在 `apps/desktop/src/components/ChatWindow.vue` 的 `loadHistory` + `watch(props.sessionId)`。

## 3. 依赖与版本（已验证兼容）

- 新增 `@langchain/langgraph-checkpoint-postgres@^0.0.5`。
  - 其 peerDependency：`@langchain/langgraph-checkpoint: ~0.0.15`、`@langchain/core: >=0.2.31 <0.4.0`。
  - 本仓库已装 `@langchain/langgraph-checkpoint@0.0.18`、`@langchain/core@0.3.80`、`@langchain/langgraph@0.2.74` —— 全部满足。
- ⚠️ **该版本的 saver 没有 `deleteThread()`**（base saver 仅 `getTuple/list/put/putWrites`；`deleteThread` 是 0.1.x/1.x 才加的）。因此 checkpoint 清理改用「直接 SQL 删行」（best-effort）。
- 用 pnpm 安装：`pnpm --filter <runtime-pkg> add @langchain/langgraph-checkpoint-postgres@^0.0.5`（实现时锁定具体小版本）。

> 实现时需确认的 API 细节（不影响设计可行性，TDD 阶段验证）：
> - `PostgresSaver.fromConnString(PG_URL)` 或 `new PostgresSaver(pool)` 的确切构造方式；
> - `await saver.setup()` 建表；
> - 续跑用 `graph.stream(null, { configurable:{ thread_id } })`（传 `null` 输入 = 从 checkpoint 续）；
> - `graph.getState({ configurable:{ thread_id } })` 返回 `{ values, next, ... }`，读 `values.messages`；
> - PostgresSaver 自管表名（用于 best-effort 清理的 DELETE 目标）。

## 4. 架构总览

```
chat.send ──→ runExecution(threadId=sessionId:roundId)
                 ├─ setPendingThread(sessionId, threadId)
                 ├─ graph.stream(initialState, {configurable:{thread_id}})  ← 每节点落 checkpoint 到 PG
                 ├─ 正常完成: appendMessages → clearPendingThread → 删 checkpoint(best-effort)
                 └─ 用户停止: 丢弃 → clearPendingThread → 删 checkpoint(best-effort)

进程崩溃 ──→ pending_thread_id 残留 (没机会清理)

重开会话 ──→ chat.getResumable(sessionId)
                 └─ pending_thread_id 非空 & 不 busy → getState → 返回 {resumable, pendingTurns}
            前端渲染 pendingTurns + 显示「上一轮未完成 [继续]」
点「继续」──→ chat.resume(sessionId)
                 └─ resumeExecution: graph.stream(null, {configurable:{thread_id}})
                    → SSE 续跑 → appendMessages → clearPendingThread → round_done
```

## 5. 详细设计

### 5.1 Checkpointer 单例 — 新增 `apps/runtime/src/graph/checkpointer.ts`
- 模块级单例 `PostgresSaver`，复用 `PG_URL` / `getPgPool()`。导出 `getCheckpointer()`。
- 单例的意义：`model.set` 会 `buildGraph()` 重建图（`rpcServer.ts` / `index.ts` 的 graphHolder），重建后必须复用**同一** saver，才能读到崩溃前写下的 checkpoint。

### 5.2 启动建表 — `apps/runtime/src/bootstrap.ts`
- 在 `pingDb()` 之后、`buildGraph()` 之前，`await getCheckpointer().setup()` 跑一次（幂等，建 `checkpoints*` 等库自管表，与 `meetmind_*` 业务表并存于同库）。

### 5.3 编译带 checkpointer — `apps/runtime/src/graph/builder.ts`
- `graph.compile()` → `graph.compile({ checkpointer: getCheckpointer() })`。
- **连带影响**：编译带 checkpointer 后，所有 `stream()`/`invoke()` 必须带 `configurable.thread_id`，否则 LangGraph 抛错。涉及：
  - `runExecution.ts`（新增 threadId，见 5.5）；
  - `apps/runtime/src/cli/main.ts` 的 `graph.stream(...)`（补一个临时 `thread_id`，如 `cli:<时间戳>`；CLI 不做恢复，仅满足要求；checkpoint 残留无害，thread_id 唯一不复用）。

### 5.4 thread_id 方案 + 在途标记 — `apps/runtime/src/database/chat/chatStore.ts`
- `thread_id = ${sessionId}:${roundId}`，`roundId` 用时间戳或 `randomUUID()`，每轮独立 thread。
  - **不**用裸 `sessionId`：否则新一轮 `stream(initialState, {thread_id:sessionId})` 在旧 checkpoint 存在时会被当作「对旧状态的更新」而误续，状态污染。每轮唯一 thread_id 保证每轮从干净状态起。
- `sessions` 表加列：`ALTER TABLE <prefix>_sessions ADD COLUMN IF NOT EXISTS pending_thread_id TEXT`（放进 `ensureChatTables()`，沿用现有幂等迁移风格）。
- 新增函数：
  - `setPendingThread(sessionId, threadId)` —— 轮开始时写。
  - `clearPendingThread(sessionId)` —— 正常完成 / 用户停止时清（置 NULL）。
  - `getPendingThread(sessionId): Promise<string | null>` —— 探测可恢复轮次。
- 语义：`pending_thread_id` 非空 = 「该会话有一个在途、尚未收尾的轮次」。崩溃时它不会被清，即「可恢复」信号。

### 5.5 runExecution 改造 — `apps/runtime/src/server/runExecution.ts`
- 进函数：生成 `roundId` + `threadId = ${sessionId}:${roundId}`；`await setPendingThread(sessionId, threadId)`。
- `graph.stream(initialState, { recursionLimit, streamMode:["custom","values"], signal, configurable:{ thread_id: threadId } })`。
- 正常完成分支：`appendMessages(newTurns)` 后 `await clearPendingThread(sessionId)` + best-effort 删该 thread checkpoint（见 5.8）。
- 用户停止分支（`signal.aborted`，含 stream 抛错的 catch）：**维持丢弃** + `clearPendingThread` + best-effort 删 checkpoint（停止=故意不要，不留续跑）。
- 抽出删 checkpoint 的逻辑为可复用 helper，供 resume 完成时也调用。

### 5.6 恢复执行 — 新增 `resumeExecution(graph, sessionId, signal)`（同文件或新文件）
- `threadId = await getPendingThread(sessionId)`；为空直接返回（无可恢复轮）。
- `priorCount = (await chatStore.getMessages(sessionId)).length`（崩溃轮从未落库，故 `priorCount` == 该轮开始时的基线）。
- `graph.stream(null, { recursionLimit, streamMode:["custom","values"], signal, configurable:{ thread_id: threadId } })`：
  - 传 `null` = 从最后一个 checkpoint 续；只重跑「崩溃时未完成的节点」及其后续；已完成节点不重放。
  - `messages` 是 concat reducer，崩溃节点没提交过写入 → 不会重复 append。
  - 崩溃前已 stream 过的 delta 前端已随刷新丢失，恢复时只 stream 续跑部分（崩溃前的发言由 5.7 的 `pendingTurns` 在点「继续」前先渲染）。
- 完成：`finalState.messages.slice(priorCount)` → `appendMessages` → `clearPendingThread` → best-effort 删 checkpoint → SSE `round_done`。
- 恢复中再被用户打断：同 runExecution 的停止语义（丢弃本次恢复尝试 + 清 pending + 删 checkpoint）。

### 5.7 两个新 RPC — `apps/runtime/src/server/rpcServer.ts`
- `chat.getResumable { sessionId }`：
  - 参数校验（非空字符串）。
  - 若 `sessions.isBusy(sessionId)` → `{ resumable:false }`（正在跑，不提示恢复）。
  - `threadId = await getPendingThread(sessionId)`；为空 → `{ resumable:false }`。
  - `state = await graph.current.getState({ configurable:{ thread_id: threadId } })`；
    `dbCount = (await chatStore.getMessages(sessionId)).length`；
    `pendingTurns = state.values.messages.slice(dbCount)`。
  - `pendingTurns.length === 0` → `{ resumable:false }`（边界：状态里没有超出 DB 的发言，无意义续）。
  - 否则 `{ resumable:true, pendingTurns }`。
- `chat.resume { sessionId }`：仿 `chat.send`——
  - 校验 + `isSessionEnded` 拒绝 + `isBusy` 拒绝。
  - `setBusy(true)` + `AbortController` + `setController`。
  - **不 await** 调 `resumeExecution(graph.current, sessionId, controller.signal)`，`.catch` 兜异常、`.finally` 清 busy/controller（与 chat.send 完全一致）。
  - 立即回 `{ ok:true }`，发言走 SSE。
- SSE 层无需任何改动：turn_start/delta/turn_end/round_done 与正常轮同构，前端 `App.vue` 已全局订阅。

### 5.8 Checkpoint 清理（best-effort）
- 该 checkpoint-postgres 版本无 `deleteThread`，故在 checkpointer 模块导出 `deleteThreadCheckpoints(threadId)`：用 `getPgPool()` 对 PostgresSaver 自管表按 `thread_id` `DELETE`（表名实现时确认，通常含 `checkpoints` / `checkpoint_blobs` / `checkpoint_writes`）。
- 全程 try/catch，删失败只 log warn，**绝不影响本轮成败**。
- 即使清理失败，因 thread_id 每轮唯一、永不复用，残留 checkpoint 不会被误续，最坏只是占用空间。

### 5.9 前端 — `apps/desktop/src/components/ChatWindow.vue` + `apps/desktop/src/stores/chat.ts`
- 会话打开/切换（现有 `loadHistory` + `watch(props.sessionId)`）后，`session.messages` 加载完，再调 `rpc("chat.getResumable", { sessionId })`。
- `resumable` 为真：
  - 把 `pendingTurns` 作为已落定气泡 append（复用 `chat.load` 的 StoredTurn→Bubble 思路，`turnEnded:true`）；
  - chat store 新增 per-session 标记 `resumableBySession[sessionId]=true`，输入框上方据此显示提示条 **「上一轮未完成」+「继续」按钮**。
- 点「继续」：
  - 设 `busy=true`、清 `resumable` 标记；
  - `rpc("chat.resume", { sessionId })`；
  - 续跑发言经既有 SSE handler 流式进来，`round_done` 收尾（沿用 `finishRound`）。
- 不渲染 `addUser`：用户原话已在 `pendingTurns` 内。
- 「停止 = 丢弃」不受影响：停止轮 `pending_thread_id` 已清，`getResumable` 返回 false，不弹提示。

## 6. 边界与已知取舍

- **粒度**：恢复到「上一个跑完的节点」，崩溃节点整体重跑（含其工具循环重来）。不做逐工具级恢复。
- **并发**：一个会话至多一个在途轮（`isBusy` 串行化保证），单列 `pending_thread_id` 足够。
- **工具审批挂起时崩溃**：该 pending 审批丢失；恢复重跑该节点会重新发审批请求（可接受）。
- **checkpoint 体积**：checkpoint 的 state 含整轮 `messages`（prior+userTurn+已产出 agent），是 prior 历史的临时副本，正常轮完成即清；只有崩溃轮的副本会留到下次「继续」收尾。
- **CLI**：仅补临时 thread_id，会在 PG 写 checkpoint（demo 可接受），不提供恢复入口。

## 7. 验收标准

1. 正常一轮讨论功能不回归（CLI + desktop）；轮末 `pending_thread_id` 被清。
2. 模拟崩溃（轮跑到中途 kill runtime）：重启后该会话 `chat.getResumable` 返回 `resumable:true` 且 `pendingTurns` 含崩溃前发言。
3. 前端重开该会话显示「上一轮未完成 [继续]」，崩溃前发言已渲染。
4. 点「继续」从崩溃节点续跑，发言流式补全，`round_done` 后整轮（userTurn+全部 agent）正确落库且无重复。
5. 用户手动「停止」的轮次：`getResumable` 返回 false，不可恢复（维持现状）。
6. `model.set` 切模型后，仍能对切换前崩溃的轮次正常续跑（验证 saver 单例）。

## 8. 不提交说明

按仓库主人的标准约定（见 MEMORY.md：不主动 git commit / push / PR），本 spec 文档**写入工作区但不自动提交**。需要提交时请明确告知。
