# 结束会议 + 生成会议纪要 markdown — 设计文档

日期: 2026-06-03
分支: ts-dev
状态: 已确认，待写实现计划

## 1. 目标

在 desktop 前端「发送」按钮右侧新增一个「结束」按钮。点击后代表本次会议结束：

1. 前端弹出模态框「当前会议已结束，正在整理会议纪要」。
2. runtime 收到请求后（当前会话内容已由 `runDiscussion` 在每轮结束时落库，无需额外保存）：
   - 让**架构师**总结出一份「会议纪要」；
   - 让**每个 agent**（含架构师）各自总结自己在本次需求中要做的工作（与本职无关则输出「无」）；
   - 把以上内容组装成**一个** markdown 文件，写到 `data/summary/{sessionId}.md`。
3. 整理完成后前端弹窗更新为「会议纪要已生成」并显示文件路径。

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 「结束」按钮可用性 | **仅空闲（非 busy）时可点**；讨论进行中置灰。服务端再做一道兜底。 |
| 弹窗行为 | 显示进度，整理完成后经 SSE 更新为「已生成」，由用户点「关闭」收起。 |
| 生成策略 | 架构师生成**一份共享会议纪要**（1 次 LLM 调用）；5 个 agent 各生成自己的「工作」段（5 次调用）。共 6 次调用。 |
| 文件结构 | **一个会议一个 md**，不按 agent 分类。第一部分=会议纪要，第二部分=各 agent 的工作。 |
| 输出路径 | `data/summary/{sessionId}.md`（`sessionId` 即「会议 uuid」，由 `randomUUID()` 生成）。 |

## 3. 架构与数据流

```
[Composer 结束按钮] --emit('end')--> [ChatWindow.onEnd]
        |                                   |
        |  打开 MeetingEndDialog(summarizing) |
        v                                   v
   rpc("chat.end", {sessionId}) ----HTTP POST /api----> [rpc.handleRpc]
                                                              |
                              busy? 是 → -32000 拒绝          | 否
                                                              v
                                  setBusy(true); 不 await 地跑 summarizeMeeting(sessionId)
                                  立即回 {ok:true}
                                                              |
                                                              v
                                        [server/meetingSummary.summarizeMeeting]
                                          getMessages → formatTranscript
                                          architect.summarizeMinutes()         (1 次)
                                          for each agent: summarizeWork()       (5 次)
                                            └ sse.send(summary_progress)
                                          composeSummaryMarkdown()
                                          mkdir -p data/summary; writeFile
                                          sse.send(summary_done {file})
                                                              |
        [ChatWindow SSE handlers] <----event: summary_*------+
        onSummaryProgress / onSummaryDone / onSummaryError
        → 更新 MeetingEndDialog 状态
```

要点：与 `chat.send` 一致，`chat.end` **不 await** 重活，HTTP 立即返回，整理过程经 SSE 推。整理事件**直接调 `sse.send`**，不经 LangGraph 的 `config.writer`（不走图）。

## 4. 后端改动

### 4.1 `apps/runtime/src/agents/base.ts` — BaseAgent 新增两个方法

两个方法都是**纯 LLM 调用**：用 `this._model.invoke([SystemMessage(systemPrompt), HumanMessage(提示)])`，**不带工具、不走 `withStructuredOutput`、不流式**，返回 markdown 正文字符串（标题由文件组装函数另加）。各自 try/catch 兜底，失败返回占位文本而非抛出，避免一个 agent 失败拖垮整批。

- `async summarizeMinutes(transcript: string): Promise<string>`
  - 提示（架构师视角）：基于完整会议记录，提炼一份简洁会议纪要——用户提出了什么需求/问题、讨论达成的关键结论与决策、未决事项。用 markdown 正文输出，**不要加一级/二级标题**。
  - 失败兜底：返回 `"(会议纪要生成失败: <err>)"`。
- `async summarizeWork(transcript: string): Promise<string>`
  - 提示（本 agent 视角）：基于会议记录，总结你（`ROLE_DESCRIPTIONS[this.name]`）在本次需求中需要完成的具体工作/行动项；**若架构师的需求与你的职责无关、你没有要做的事，就只输出两个字「无」**。不要加标题。
  - 失败兜底：返回 `"(生成失败: <err>)"`。
- 公共细节：进入前 `cleanBadChars(transcript)`；`this._model.invoke` 返回 `AIMessage`，其 `content` 可能是 string 或数组，用小helper 收敛成字符串后 `.trim()`。

### 4.2 `apps/runtime/src/graph/builder.ts` — 导出 `buildAllAgents`

当前 `buildAllAgents()` 是文件内私有函数。改为 `export function buildAllAgents()`，供整理模块复用同一套 agent 构造逻辑。图本身行为不变。

### 4.3 `apps/runtime/src/server/meetingSummary.ts` — 新建

```ts
// 懒加载单例：与图各持一套无状态 agent，互不干扰；整理不走 RAG。
function getSummaryAgents(): Record<string, BaseAgent>   // 缓存 buildAllAgents()

// 把整轮转录拼成纯文本喂给 LLM（含 user 轮）。
export function formatTranscript(messages: AgentResponse[]): string

// 纯函数：把纪要 + 各 agent 工作段组装成整份 markdown。generatedAt 由调用方传入以便测试。
export function composeSummaryMarkdown(
  sessionId: string,
  minutes: string,
  works: Array<{ role: string; body: string }>,
  generatedAt: string,
): string

// 主流程：读消息 → 架构师纪要 → 各 agent 工作（逐个推 progress）→ 写单文件 → summary_done。
// 自身 try/catch 包裹，失败 sse.send("summary_error")，绝不抛出（rpc 侧 .catch 仅兜底）。
export async function summarizeMeeting(sessionId: string): Promise<void>
```

`summarizeMeeting` 逻辑：
1. `messages = await chatStore.getMessages(sessionId)`；`messages.length === 0` → `sse.send(sessionId, "summary_error", {message:"本次会议尚无讨论内容，无法生成纪要"})` 后返回。
2. `transcript = formatTranscript(messages)`。
3. `minutes = await agents[ARCHITECT].summarizeMinutes(transcript)`。
4. 遍历 `AGENT_NAMES`（架构师也在内），逐个：先 `sse.send(sessionId, "summary_progress", {agent:name, role:ROLE_DESCRIPTIONS[name], index, total:AGENT_NAMES.length})`，再 `body = await agents[name].summarizeWork(transcript)`，push `{role: ROLE_DESCRIPTIONS[name], body}`。
5. `generatedAt = new Date().toISOString()`；`md = composeSummaryMarkdown(...)`。
6. `dir = path.join(PROJECT_ROOT, "data", "summary")`；`await mkdir(dir, {recursive:true})`；`file = path.join(dir, sessionId + ".md")`；`await writeFile(file, md, "utf8")`。
7. `sse.send(sessionId, "summary_done", {file})`。

依赖：`PROJECT_ROOT`（`config/settings.js`）、`node:fs/promises` 的 `mkdir`/`writeFile`、`node:path`、`AGENT_NAMES`/`ARCHITECT`/`ROLE_DESCRIPTIONS`（`config/constants.js`）、`chatStore`、`sse`、`buildAllAgents`。文件路径标题统一用 `ROLE_DESCRIPTIONS[name]`（如「后端工程师 (Backend Engineer)」），区别于 `agent.role`（如「后端工程师」）。

### 4.4 `apps/runtime/src/server/rpc.ts` — 新增 `chat.end`

```ts
if (body.method === "chat.end") {
  const sessionId = params.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return rpcError(id, -32602, "缺少 sessionId");
  if (sessions.isBusy(sessionId)) return rpcError(id, -32000, "讨论进行中，无法结束会议");
  sessions.setBusy(sessionId, true);
  const running = summarizeMeeting(sessionId);
  running
    .catch((exc) => {
      console.error(`[rpc] summarizeMeeting 未捕获异常 (会话 ${sessionId}):`, exc);
      sse.send(sessionId, "summary_error", { message: String(exc) });
    })
    .finally(() => { sessions.setBusy(sessionId, false); });
  return rpcOk(id, { ok: true });
}
```

新增 import：`summarizeMeeting`（`./meetingSummary.js`）、`sse`（`./sse.js`）。

> 注意：runtime 用 tsx 起、不 watch。本次新增 RPC method 后**必须重启 runtime 进程**，否则前端调 `chat.end` 会收到「未知方法」。

## 5. 前端改动

### 5.1 `apps/desktop/src/components/Composer.vue`

发送/打断按钮右侧新增「结束」按钮：`emit` 增加 `end: []`；按钮 `:disabled="busy"`（仅空闲可点）、`title="结束会议"`、`@click="emit('end')"`。配套灰色样式（区别于发送蓝、打断红），`:disabled` 态降透明度。

### 5.2 `apps/desktop/src/components/MeetingEndDialog.vue` — 新建

模态弹窗（参考 `ConfirmDialog.vue` 的 overlay/dialog 样式）。props：`status: "summarizing" | "done" | "error"`、`message: string`、`detail?: string`。emit：`close: []`。

- `summarizing`：显示 `message`（「当前会议已结束，正在整理会议纪要」）+ `detail`（进度，如「正在整理：后端工程师 (Backend Engineer)（2/5）」）+ `TypingDots` 转圈；**不显示关闭按钮**（强制等结果）。
- `done`：显示「✓ 会议纪要已生成」+ `detail`（文件路径）+「关闭」按钮。
- `error`：显示「✗ {message}」+「关闭」按钮。

### 5.3 `apps/desktop/src/components/ChatWindow.vue`

- 新增响应式 `summary` 状态：`{ open, status, message, detail }`。
- `connect()` 的 `openEvents` 回调增加三个 handler：
  - `onSummaryProgress(p)` → `summary.detail = `正在整理：${p.role}（${p.index}/${p.total}）``
  - `onSummaryDone(p)` → `status="done"; message="会议纪要已生成"; detail=p.file`
  - `onSummaryError(p)` → `status="error"; message=p.message`
- `onEnd()`：置 `summary = {open:true, status:"summarizing", message:"当前会议已结束，正在整理会议纪要", detail:""}`，再 `await rpc("chat.end", {sessionId})`；rpc 抛错则 `status="error"; message=String(e)`。
- 模板：`<Composer ... @end="onEnd" />`；`<MeetingEndDialog v-if="summary.open" :status :message :detail @close="summary.open=false" />`。

### 5.4 `apps/desktop/src/api/sseClient.ts`

- 新增 payload 类型：`SummaryProgressPayload {agent; role; index; total}`、`SummaryDonePayload {file}`、`SummaryErrorPayload {message}`。
- `SseHandlers` 增 `onSummaryProgress` / `onSummaryDone` / `onSummaryError`。
- 增 `es.addEventListener("summary_progress" | "summary_done" | "summary_error", ...)`，与现有事件同样 `JSON.parse(e.data)` 后转交 handler。（`summary_error` 是独立事件名，与 EventSource 原生 `error` / 现有业务 `error` 互不冲突。）

## 6. markdown 文件格式

`composeSummaryMarkdown` 产出（`works` 顺序即 `AGENT_NAMES`：architect, backend, frontend, tester, pm）：

```markdown
# 会议纪要

> 会议 ID: <sessionId>
> 生成时间: <generatedAt>

## 一、会议纪要

<架构师生成的会议纪要>

## 二、各 Agent 的工作

### 架构师 (Architect / Tech Lead)

<工作段，或「无」>

### 后端工程师 (Backend Engineer)

<工作段，或「无」>

### 前端工程师 (Frontend Engineer)

<工作段，或「无」>

### 测试工程师 (QA Engineer)

<工作段，或「无」>

### 产品经理 (Product Manager)

<工作段，或「无」>
```

## 7. 错误处理与边界

- **无消息**：`summary_error`「本次会议尚无讨论内容，无法生成纪要」，弹窗显示错误 + 关闭。
- **单个 agent LLM 失败**：该段落填「(生成失败: …)」，其它继续，整体仍 `summary_done`。
- **架构师纪要失败**：纪要部分填「(会议纪要生成失败: …)」，继续。
- **写文件失败 / 其它意外**：`summarizeMeeting` 顶层 catch → `summary_error`；rpc 的 `.catch` 是二次兜底。
- **并发**：`chat.end` 与 `chat.send` 共用 `sessions.isBusy`/`setBusy` 互斥；整理期间 busy=true，整理结束 `finally` 清掉。整理过程不可被打断（不注册 AbortController）。
- 前端 `busy` 是前端 store 状态，`chat.end` 不调 `addUser`，因此整理期间**不会**触发 ChatWindow 的「思考中」气泡；弹窗是唯一反馈。

## 8. 测试

- 新建 `apps/runtime/src/server/meetingSummary.test.ts`（vitest）：
  - `composeSummaryMarkdown`：传入固定 `sessionId/minutes/works/generatedAt`，断言含「# 会议纪要」「## 一、会议纪要」「## 二、各 Agent 的工作」、5 个 `### {role}` 小节、纪要与各工作段正文、`> 会议 ID:` 行。验证「无」段落原样出现。
  - `formatTranscript`：传入若干 `AgentResponse`，断言含各 role/正文且空数组返回空串。
- LLM/文件/RPC 接线部分手动验证（最短路：`pnpm dev:runtime` 3002 + `pnpm dev:desktop` 5173，浏览器实操，**改 RPC 后重启 runtime**）。
- 不强行 mock 模型；`summarizeMinutes/summarizeWork` 的真实 LLM 行为靠手动验证。

## 9. 涉及文件清单

新增：
- `apps/runtime/src/server/meetingSummary.ts`
- `apps/runtime/src/server/meetingSummary.test.ts`
- `apps/desktop/src/components/MeetingEndDialog.vue`

修改：
- `apps/runtime/src/agents/base.ts`（+2 方法）
- `apps/runtime/src/graph/builder.ts`（导出 `buildAllAgents`）
- `apps/runtime/src/server/rpc.ts`（+`chat.end`）
- `apps/desktop/src/components/Composer.vue`（+结束按钮/emit）
- `apps/desktop/src/components/ChatWindow.vue`（+summary 状态/handler/弹窗）
- `apps/desktop/src/api/sseClient.ts`（+3 事件）
