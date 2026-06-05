# 设计：首条消息自动生成会话标题

日期：2026-06-05
状态：已批准设计，待实现

## 目标

新建会话后，用户输入**第一条**请求时，runtime 用 LLM 把该输入总结成一个简短标题
（≤15 字），与架构师讨论**并行**进行；生成后回传前端并写入 `meetmind_sessions.title`，
前端据此更新顶栏与侧栏的会话标题。

## 数据流

```
用户在新会话发首条消息 (ChatWindow.onSend)
        │
        ├─(并行 A) rpc("chat.summaryTitle", {sessionId, requirement})   ← fire-and-forget，不 await
        │            └─ runtime: summarizeTitle(LLM) → 去\n+截断15字 → renameSession(DB) → {ok,title}
        │            └─ 前端 .then: sessions.setTitle(id, title) → 顶栏 & 侧栏标题刷新
        │
        └─(并行 B) rpc("chat.send", ...)   ← await，架构师讨论照常
```

两条独立 HTTP 请求天然并行；前端先 fire 触发 A（不阻塞），再 await B。

## 后端改动

### 1. 新文件 `apps/runtime/src/server/titleSummary.ts`

导出 `summarizeTitle(requirement: string): Promise<string>`：

- 用 `getSettings()` 读当前模型配置，构造轻量 `ChatOpenAI`（镜像 `rpcServer.ts` 里 `model.test`
  探针：`maxRetries:0`、`timeout`、`temperature:0`、小 `maxTokens`、
  `modelKwargs:{thinking:{type:"disabled"}}`）。每次调用现读 settings，`model.set` 热切换后自动生效。
- 提示词：
  `这是用户输入：${requirement}\n请你将它总结成一个简短的会话标题，要求 15 个字以内，只返回标题本身，不要换行、不要标点符号、不要解释。`
- 拿到回复文本 → 去掉所有 `\n`/`\r` → `trim()` → 兜底截断到 15 字 → 返回。
- 清洗逻辑抽成可单测的纯函数（如 `cleanTitle(raw): string`），便于断言去换行 + 截断。

### 2. `rpcServer.ts` 新增 `chat.summaryTitle` 分支

- 校验 `sessionId` / `requirement` 为非空字符串，否则 `rpcError(-32602)`。
- `await summarizeTitle(requirement)`：
  - 抛错或空标题 → 返回业务失败 `rpcOk(id, {ok:false})`（仿 `user.login`，不走 `rpcError`，前端不抛）。
  - 成功 → `await chatStore.renameSession(sessionId, title)` 后返回 `rpcOk(id, {ok:true, title})`。
- 后端不判断「是否首条」；由前端只在首条时调用。

## 前端改动

### 1. `sessions` store 新增 `setTitle(id, title)`

只同步本地 `list` 里对应会话的 `title`（DB 已由后端那次 RPC 改过，不再重复发 `session.rename`）。
显式 for 循环，house style。

### 2. `ChatWindow.onSend`

- `chat.addUser` 前记 `const isFirst = chat.bubblesOf(props.sessionId).length === 0`。
- 若 `isFirst`，并行 fire：
  `rpc<{ok:boolean;title?:string}>("chat.summaryTitle", {sessionId, requirement:text})`
  `.then(res => { if (res.ok && res.title) sessions.setTitle(props.sessionId, res.title); })`
  `.catch(() => {})`（标题摘要失败不影响讨论，静默忽略）。
- 不 await、不阻塞随后的 `await rpc("chat.send", ...)`。
- 重开带历史的会话 bubbles 非空 → `isFirst` 为 false → 不重复生成。

## 错误处理 & 边界

- LLM 失败 / 超时 / 空标题 → 静默保留默认标题（「会话 N」），讨论不受影响。
- 标题摘要与架构师各自独立调 LLM，互不阻塞、互不影响。
- 只在「该会话本地零气泡」时触发 = 真·首条；手动重命名后的后续消息不会被覆盖。

## 测试

- `titleSummary` 纯函数 `cleanTitle`：输入带换行 / 超 15 字的串，断言去 `\n` + 截断结果。
- `rpcServer.test.ts` 加 `chat.summaryTitle`：参数校验失败路径；成功路径（mock `summarizeTitle`）
  断言调用 `renameSession` 并返回 `{ok:true,title}`。

## 影响文件

- 新增：`apps/runtime/src/server/titleSummary.ts`
- 改：`apps/runtime/src/server/rpcServer.ts`
- 改：`apps/desktop/src/stores/sessions.ts`
- 改：`apps/desktop/src/components/ChatWindow.vue`
- 测试：`apps/runtime/src/server/titleSummary.test.ts`（新）、`apps/runtime/src/server/rpcServer.test.ts`
