# MeetMind 桌面前端 + Monorepo 改造设计

- 日期：2026-06-01
- 分支：ts-dev
- 状态：已与用户对齐，待评审

## 1. 目标

为现有的多 Agent RAG 协作系统（当前是纯 CLI，全部代码在 `src/`）增加一个桌面前端：

- **前端**：Tauri 2 + Vue 3 + Vite + Pinia，开发端口 **5173**。
- **后端（runtime）**：把现有引擎包成 HTTP/SSE 服务，端口 **3002**。
- **通信**：前端用 JSON-RPC 走 `POST /api` 触发讨论，用 SSE 走 `GET /events` 接收 agent 的**真·LLM-token 流式**回复。
- **结构**：改成 pnpm monorepo —— `apps/runtime`（引擎 + 服务）+ `apps/desktop`（前端）。
- 暂不持久化会话（前端刷新即丢会话列表）；同一会话内多次发送**累计上下文**（复刻 CLI 的跨轮记忆）。
- CLI 代码保留但不再是入口（暂不使用）。

## 2. Monorepo 布局

`src/` 整体迁入 `apps/runtime/src/`；新增 `apps/desktop/`。`data/`、`models/`、`docker-compose.yml` 留在仓库根（两个 app 共享）。

```
MeetMind/
├─ pnpm-workspace.yaml          # packages: ["apps/*"]
├─ package.json                 # 根:编排脚本(dev 同时起 runtime + desktop)
├─ tsconfig.base.json           # 抽出共享编译选项,各 app 的 tsconfig extends 它
├─ data/  models/  docker-compose.yml      # 留根,共享
├─ docs/superpowers/specs/      # 本设计文档
├─ apps/
│  ├─ runtime/                  # 引擎 + HTTP/SSE 服务
│  │  ├─ src/
│  │  │  ├─ agents/ graph/ database/ tools/ config/ utils/   # 原样从 src/ 搬来
│  │  │  ├─ cli/                # 保留,不再是入口
│  │  │  ├─ server/             # 【新增】
│  │  │  │  ├─ httpServer.ts    # 监听 3002, 路由 /api 与 /events, CORS
│  │  │  │  ├─ rpc.ts           # POST /api 上的 JSON-RPC 2.0 分发
│  │  │  │  ├─ sse.ts           # GET /events 的 SSE 连接管理(按 sessionId)
│  │  │  │  ├─ sessions.ts      # 内存会话表 Map<sessionId, AgentResponse[]>
│  │  │  │  └─ runDiscussion.ts # 包 graph.stream → 转发 turn/delta/done 事件
│  │  │  ├─ bootstrap.ts        # 从原 cli/main.ts 抽出的自检+灌库(供 server 与 cli 共用)
│  │  │  └─ index.ts            # dotenv → bootstrap → listen(3002)
│  │  ├─ package.json           # name "@meetmind/runtime"
│  │  └─ tsconfig.json
│  └─ desktop/                  # Tauri2 + Vue3 + Vite + Pinia
│     ├─ index.html
│     ├─ vite.config.ts         # 5173; 把 /api 与 /events 代理到 3002
│     ├─ src/
│     │  ├─ main.ts  App.vue
│     │  ├─ api/ rpcClient.ts  sseClient.ts
│     │  ├─ stores/ sessions.ts  chat.ts        # Pinia
│     │  ├─ components/ SessionList.vue ChatWindow.vue MessageBubble.vue Composer.vue
│     │  └─ theme/ agentColors.ts               # agent_name → 颜色
│     ├─ src-tauri/             # Rust 外壳(用户装好 Rust 后 `pnpm tauri init` 生成)
│     ├─ package.json           # name "@meetmind/desktop"
│     └─ tsconfig.json
```

### 迁移要保住的硬约束

- **ESM/NodeNext 的 `.js` import 后缀**：搬目录不改 import 写法，相对 import 仍写 `./foo.js`。
- **`PROJECT_ROOT` 与 `resolveRel`**：`config/settings.ts` 把 `SEED_DATA_PATH`、`EMBEDDING_CACHE_DIR` 等相对路径锚定到 `PROJECT_ROOT`。`data/`、`models/` 留在仓库根，迁移后必须确认 `PROJECT_ROOT` 仍解析到仓库根（而非 `apps/runtime`），否则找不到种子/模型。`.env` 也仍在仓库根。
- **入口顺序**：`index.ts` 先 `config()`（dotenv）再动态 `import` 其余模块（LangSmith 等 SDK 在 import 期读 env）。
- **`pnpm-workspace.yaml` 的 `allowBuilds`**（esbuild / onnxruntime-node / protobufjs / sharp）需保留。

## 3. 通信协议

### 3.1 `POST /api` —— JSON-RPC 2.0

| method | params | 返回 | 说明 |
|---|---|---|---|
| `chat.send` | `{ sessionId, requirement }` | `{ ok: true }`（立即返回） | 触发一轮讨论；agent 输出全走 SSE。同一会话已有讨论在跑时返回 JSON-RPC error（拒绝重入）。 |
| `session.reset` | `{ sessionId }` | `{ ok: true }` | 清空该会话的内存记忆。 |

### 3.2 `GET /events?sessionId=…` —— SSE

前端建会话时连上，服务端按 sessionId 推送：

| event | data | 含义 |
|---|---|---|
| `turn_start` | `{ turnId, agent_name, role }` | 某 agent 开始发言（前端建空气泡） |
| `delta` | `{ turnId, text }` | 该气泡追加一小段文字（真·token） |
| `turn_end` | `{ turnId, next_agent, done, used_rag }` | 该发言结束 |
| `round_done` | `{ done }` | 本轮讨论结束 |
| `error` | `{ message, turnId? }` | 出错（前端显示错误气泡，服务不崩） |

### 3.3 CORS

runtime 放行 `http://localhost:5173`（Vite dev）与 `tauri://localhost`/`https://tauri.localhost`（Tauri 打包后前端 origin）。开发期 Vite proxy 已让 `/api`、`/events` 同源，CORS 主要为 Tauri 打包态服务。

## 4. 真·LLM-token 流式（核心机制）

agent 展示给用户的正文是 `AgentResponse.message`，来自 `BaseAgent.invoke` 的 **Phase 2 `withStructuredOutput(ModelOutputSchema)`**。流式分三段衔接：

1. **Phase 2 改流式**：`BaseAgent.invoke` 增加可选第三参 `opts?: { onDelta?: (text: string) => void }`。
   - 不传 `onDelta`（CLI 路径）：行为不变，`.invoke()` 一次拿结果。
   - 传 `onDelta`（server 路径）：对结构化 runnable 走 `.stream()`，逐帧拿到正在长大的 partial 对象，`diff` 其 `content` 字段，把新增那截传给 `onDelta`，循环结束用最后一帧（完整对象）走原 `_buildAgentResponse` 构造 `AgentResponse`。
   - **优雅降级**：若后端不吐 partial（结构化流式在 OpenAI 兼容后端偶发不稳），`content` 会在最后一次性到达 → 退化成一大段 delta，结果仍正确，只是没打字机效果。Phase 1 工具循环不变（工具结果非用户可见正文，不需要流式）。

2. **token 冒出 graph 节点**：用 LangGraph 的 **custom 流**。`createNode` 改签名接收 `(state, config)`：
   - 节点开头 `config.writer?.({ kind: "turn_start", turnId, agent_name, role })`（`turnId = \`${agent.name}-${iteration}\``）。
   - 调 `agent.invoke(requirement, history, { onDelta: (text) => config.writer?.({ kind: "delta", turnId, text }) })`。
   - 节点结尾 `config.writer?.({ kind: "turn_end", turnId, next_agent, done, used_rag })`。
   - 返回值仍是原来的增量 state（`messages` 追加等），不变。

3. **runDiscussion 消费双模式流**：
   ```ts
   const stream = await graph.stream(initialState, {
     recursionLimit: 50,
     streamMode: ["custom", "values"],
   });
   let finalState = initialState;
   for await (const [mode, chunk] of stream) {
     if (mode === "custom") {
       sse.send(sessionId, chunk.kind, chunk);   // turn_start / delta / turn_end 透传
     } else {
       finalState = chunk;                         // values 帧:留最后一帧
     }
   }
   sessions.replace(sessionId, finalState.messages);  // 更新跨轮记忆
   sse.send(sessionId, "round_done", { done: finalState.done });
   ```

## 5. 会话与跨轮记忆

`sessions.ts` 内存 `Map<sessionId, AgentResponse[]>`。`chat.send(sessionId, requirement)` 流程：

1. 取该会话已有 `messages`（首轮为空）。
2. 构造 `userTurn`（`agent_name:"user"`, `role:"用户"`, `message:requirement`, `next_agent:"architect"`, `done:false`, `used_rag:false`）。
3. `seedMessages = [...prior, userTurn]`，作为 `initialState.messages`（`requirement` 设为本次输入，`iteration:0`）。
4. 跑 `runDiscussion` → SSE 推流。
5. 用最后一帧 `messages` 覆盖回会话记忆（复刻 CLI 的 `lastState.messages` 跨轮逻辑）。

同一会话同时只允许一轮讨论：`sessions.ts` 记录 `busy` 标记，`chat.send` 重入时 JSON-RPC error 拒掉。无持久化：进程重启或前端刷新即丢（符合需求）。

## 6. 前端 UI

- **左栏会话列表**：`New chat` 按钮 + 列表（Pinia 内存）。新建会话生成 `sessionId`（前端 uuid），点击切 active 并连其 SSE。刷新即丢。
- **右栏聊天窗**：
  - 用户气泡右对齐（灰）；agent 气泡左对齐，按 `agent_name` 配色。
  - 配色（`theme/agentColors.ts`）：architect=紫 / backend=蓝 / frontend=绿 / tester=橙 / pm=粉 / user=灰。
  - 气泡头显示角色名（`ROLE_DESCRIPTIONS`）；`used_rag` 显示一个小角标。
  - token 到达时往当前 `turnId` 的气泡追加文字（打字机）。
- **底部 Composer**：textarea + 发送按钮；Enter 发送、Shift+Enter 换行；讨论进行中禁用发送（与后端 busy 对应）。
- **Pinia**：
  - `useSessionsStore`：`list`、`activeId`、`newSession()`、`select(id)`。
  - `useChatStore`：每会话 `messages: AgentBubble[]`、当前 streaming 的 `turnId`、`busy`；提供 `appendDelta`、`startTurn`、`endTurn`、`finishRound`。
- **api 层**：
  - `rpcClient.ts`：`fetch('POST', '/api', jsonRpcEnvelope)`。
  - `sseClient.ts`：`EventSource('/events?sessionId=…')`，监听各 event，断线自动重连。

## 7. 端口 / 联调 / Tauri

- runtime 监听 **3002**；Vite dev **5173**。
- `vite.config.ts` proxy：`/api`、`/events` → `http://localhost:3002`（Vite proxy 支持 SSE，需关闭对 `/events` 的缓冲）。
- Tauri：用户先装 Rust（`rustup`），再 `pnpm --filter @meetmind/desktop tauri init` 生成 `src-tauri/`；`tauri.conf.json` 的 `devUrl` 指向 `http://localhost:5173`。
- runtime 暂作**独立进程**用 `pnpm --filter @meetmind/runtime dev` 起，**不做 sidecar 内嵌**（以后再说）。
- 根 `package.json` 提供 `dev` 脚本并行起 runtime + desktop（如用 `concurrently` 或 `pnpm -r --parallel`）。

## 8. 错误处理

- runtime 启动 `pingDb()` 失败仍 `process.exit(1)`（PG 硬依赖不变）。
- 单个 turn 内 LLM/工具抛错：`runDiscussion` catch → 发 `error` 事件（带 `turnId`）→ 不崩服务，结束本轮。
- SSE 断线：前端 `EventSource` 自动重连；服务端在连接 `close` 时清理该 sessionId 的 writer 句柄。
- 重入：busy 会话的 `chat.send` 返回 JSON-RPC error，前端提示「上一轮还在进行」。

## 9. 测试与验收

- **runtime 冒烟测试**：起服务（或直接调 `runDiscussion` + mock graph 避免 LLM 开销），POST `chat.send`，断言 SSE 事件序列出现 `turn_start → delta(×N) → turn_end → round_done`。
- **跨轮记忆测试**：同 sessionId 连发两次，断言第二轮 `initialState.messages` 含第一轮发言。
- **类型检查**：全 workspace `pnpm -r typecheck` 保持绿。
- **手动验收**：装好 Rust 后 `tauri dev` 起前端，输入需求，肉眼确认 agent 气泡按角色配色、token 逐段蹦出、跨轮上下文生效。

## 10. 不做（YAGNI）

- 不做会话持久化（DB/文件）。
- 不做 Tauri sidecar 内嵌 runtime（暂独立进程）。
- 不做用户鉴权 / 多用户。
- 不动 RAG / embedding / rerank / agent 人设逻辑（除 Phase 2 加 `onDelta` 流式分支外）。
