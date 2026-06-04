# @meetmind/desktop — 桌面前端（Vue 3 + Vite + Tauri 2）

MeetMind 的前端：一个聊天式界面，展示 5 个角色 Agent 的多轮讨论。左侧会话列表，右侧讨论流（打字机式流式输出 + 每个 Agent 用过哪些工具 + 点开看工具返回结果）。通过 `POST /api`（JSON-RPC）向后端下指令、`GET /events`（SSE）收讨论流。

> 这是 monorepo 里的前端包。全栈说明见仓库根 [`README.md`](../../README.md)；后端见 [`apps/runtime`](../runtime/README.md)；调用链见 [`project_flow.md`](../../project_flow.md)。

---

## 技术栈

- **Vue 3**（`<script setup>` + Composition API） + **Pinia**（状态）+ **Vite**（开发/构建）。
- **Tauri 2**：把同一份前端打包成原生桌面外壳（`src-tauri/`，需 Rust 工具链）。开发期一般直接用浏览器连 vite 更快。
- **TypeScript**，`vue-tsc` 做类型检查；**Vitest**（happy-dom）跑单测。
- 无 UI 框架，纯手写组件 + CSS 变量主题（浅/深色，`<html data-theme>` 级联）。

---

## 运行

前置：先起后端（`pnpm dev:runtime`，监听 3002）。vite 把 `/api`、`/events` 代理到 3002。

```bash
# 在仓库根目录：
pnpm dev:desktop        # = pnpm --filter @meetmind/desktop dev → vite(5173)，浏览器联调最快

# 或在本目录 apps/desktop/：
pnpm dev                # vite，开发服务器 5173
pnpm build              # vue-tsc --noEmit && vite build
pnpm typecheck          # vue-tsc --noEmit
pnpm test               # vitest run
pnpm tauri dev          # 起 Tauri 原生外壳（需先装 Rust；会自动拉起 vite）
```

复现前端 bug 的最短路：`pnpm dev:runtime` + `pnpm dev:desktop`，用浏览器（或 Playwright）打开 `http://localhost:5173` 实操，比起 Tauri 外壳快。改了后端记得**重启 runtime**（tsx 不 watch）；前端有 HMR。

---

## 数据流

```
组件 (ChatWindow / Composer / SessionList)
   │  发指令                          ▲  收流
   ▼                                  │
api/rpcClient.ts  ──POST /api──►  runtime 3002  ──GET /events──►  api/sseClient.ts
   │  (一问一答 JSON-RPC)                               (订阅式 SSE 长连)
   ▼                                                      ▼
stores/sessions.ts                                   stores/chat.ts
（会话列表 CRUD）                          （气泡 / 流式增量 / 工具调用 / busy 态）
```

- **发**：`session.*`（增删改查会话）、`chat.send`（开一轮）、`chat.interrupt`（打断）、`chat.end`（结束并整理纪要）——都走 `rpcClient.rpc(method, params)`。
- **收**：`sseClient.openEvents(sessionId, handlers)` 订阅讨论流，`ChatWindow.vue` 把每种事件接到 `chat` store 的 action：`turn_start→startTurn`、`delta→appendDelta`、`using_tools→useTool`、`tool_result→addToolCall`、`turn_end→endTurn`、`round_done→finishRound`、`error→addErrorBubble`。

---

## 工具调用 UI（每个调用一个按钮 + 点开看结果）

后端每执行一次工具就推一条 `tool_result` 事件（`{turnId, name, args, result}`），`chat` store 把它 push 进对应气泡的 `toolCalls`。[`MessageBubble.vue`](src/components/MessageBubble.vue) 在气泡里给每次调用渲染一个 🔧 按钮，点击在正文**下方**展开该次调用的入参（`args`）+ 返回结果（`result`，超长可滚动）；再点收起、点别的切换。

历史消息的工具调用也能看：后端把 `tool_calls` 落库进 `messages.tool_calls`（jsonb），`session.messages` 取回后由 `chat.load` 映射进气泡。旧消息没有该字段则按钮区为空。

---

## 目录结构 `src/`

```text
src/
├── main.ts                 # 入口：createApp + Pinia；mount 前先 initTheme 避免主题闪烁
├── App.vue                 # 布局：SessionList + ChatWindow；启动拉会话列表 + 回灌「已结束」态
├── api/
│   ├── rpcClient.ts        # POST /api JSON-RPC（一问一答）
│   ├── sseClient.ts        # GET /events SSE（事件类型 + openEvents 订阅）
│   └── logger.ts           # 前端 pino 日志
├── stores/                 # Pinia
│   ├── chat.ts             # 气泡 Bubble（含 toolCalls）/ 流式增量 / addToolCall / busy / 历史 load
│   ├── sessions.ts         # 会话列表 + activeId + CRUD（走 rpc）
│   └── ui.ts               # 侧栏收缩 + 浅/深主题（localStorage 持久化）
├── components/
│   ├── ChatWindow.vue      # 主面板：连 SSE、渲染气泡、串联各 store
│   ├── MessageBubble.vue   # 单条气泡：角色 + 工具按钮 + 正文/打字点 + 结果面板 + 时间
│   ├── Composer.vue        # 输入框（IME 回车修复）+ 发送/打断/结束
│   ├── SessionList.vue     # 会话侧栏（新建/选中/重命名/删除）
│   ├── SessionSearch.vue   # 会话搜索
│   ├── ConfirmDialog.vue / MeetingEndDialog.vue   # 自定义弹窗
│   ├── TypingDots.vue      # 思考中流动点
│   └── Tooltip.vue
├── theme/agentColors.ts    # 每个 agent 的配色
└── shims-vue.d.ts
```

```text
src-tauri/                  # Tauri 2 原生外壳（Rust）：tauri.conf.json / Cargo.toml / icons / capabilities
```

---

## 几个约定 / 坑

- **本轮结束清空空气泡**：`chat` store 的 `finishRound` 会 pop 掉末尾「已建但没吐出任何字」的 agent 占位气泡（`!isUser && text===""`），否则它会被判定为思考中、`TypingDots` 一直跳。被打断的本轮不落库，删掉正合适。
- **消息发送时间**：纯前端展示——live 气泡用 `Date.now()`，历史气泡用 DB `messages.created_at`，`MessageBubble` 格式化成 `2026-6-2 18:23`。
- **新增 SSE 事件**：要同时改 `api/sseClient.ts`（类型 + 监听 + `SseHandlers`）、`ChatWindow.vue`（接到 store）、`stores/chat.ts`（action）——三处对齐，否则 typecheck 会报 `SseHandlers` 缺字段。
- **改后端要重启 runtime**：tsx 不 watch；前端走 vite HMR 不用。
