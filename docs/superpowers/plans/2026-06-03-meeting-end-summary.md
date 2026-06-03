# 结束会议 + 生成会议纪要 markdown 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** desktop 前端在发送按钮右侧加「结束」按钮，点击后 runtime 让架构师生成会议纪要、各 agent 生成本职工作，组装成一份 `data/summary/{sessionId}.md`，前端弹窗显示进度与结果。

**Architecture:** `chat.end` RPC 仿 `chat.send` 立即返回，后台 `summarizeMeeting` 跑 6 次 LLM 调用（架构师 1 次纪要 + 5 个 agent 各 1 次工作段），经 SSE 推 `summary_progress`/`summary_done`/`summary_error`，前端 `MeetingEndDialog` 据此更新。整理事件直接 `sse.send`，不经 LangGraph writer。

**Tech Stack:** TypeScript (ESM + NodeNext, import 带 `.js` 后缀)、LangChain `ChatOpenAI`、Vue 3 `<script setup>` + Pinia、vitest、SSE。pnpm workspace（`@meetmind/runtime` / `@meetmind/desktop`）。

**提交策略:** 本项目约定**不主动 `git commit` / push / PR**。每个 Task 末尾是「验证 Checkpoint」而非 commit；全部完成后由用户决定是否统一提交。

**通用命令:**
- 跑某个测试文件: `pnpm --filter @meetmind/runtime exec vitest run <相对 apps/runtime 的路径>`
- 跑 runtime 全部测试: `pnpm --filter @meetmind/runtime test`
- runtime 类型检查: `pnpm --filter @meetmind/runtime typecheck`
- desktop 类型检查: `pnpm --filter @meetmind/desktop typecheck`

**踩坑提醒:** 改了 runtime 服务端代码（尤其 `rpc.ts` 新增 method）后**必须重启 runtime 进程**（tsx 不 watch），否则前端调 `chat.end` 收到「未知方法」。desktop 走 vite 有 HMR 不用重启。

---

## Task 1: BaseAgent 新增 summarizeMinutes / summarizeWork

**Files:**
- Modify: `apps/runtime/src/agents/base.ts`

这两个方法是纯 LLM 调用（不带工具、不结构化、不流式），各自 try/catch 兜底。`base.ts` 已 import 了 `SystemMessage`/`HumanMessage`/`AIMessage`/`cleanBadChars`/`ROLE_DESCRIPTIONS`/`logger`，无需新增 import。LLM 相关代码不做单测，靠 typecheck + Task 8 手动验证。

- [ ] **Step 1: 在 BaseAgent 类内、`_buildAgentResponse` 方法之后追加三段代码**

在 `apps/runtime/src/agents/base.ts` 中，找到 `_buildAgentResponse` 方法的结束 `}`（约 341 行，类的倒数第二个 `}` 之前），在它后面插入：

```ts
  // ---------- 会议结束：纪要 / 工作总结 ----------

  /** AIMessage.content 可能是 string 或数组，统一收敛成字符串。 */
  private _contentToString(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    return JSON.stringify(content);
  }

  /**
   * 会议结束时由架构师调用：基于完整会议记录提炼一份会议纪要。
   * 纯 LLM 调用，返回 markdown 正文（标题由外层文件组装函数另加）。失败返回占位文本而非抛出。
   */
  async summarizeMinutes(transcript: string): Promise<string> {
    const transcript_cleaned = cleanBadChars(transcript);
    const prompt =
      "下面是一次多角色团队会议的完整记录。请你作为架构师，提炼一份简洁清晰的会议纪要：\n" +
      "用户提出了什么需求或问题、讨论中达成的关键结论与决策、以及尚未解决的待办事项。\n" +
      "用 markdown 正文输出即可，不要加一级或二级标题（标题会在外层另加）。\n\n" +
      `=== 会议记录 ===\n${transcript_cleaned}`;
    try {
      const aiMsg = (await this._model.invoke([
        new SystemMessage(cleanBadChars(this.systemPrompt)),
        new HumanMessage(cleanBadChars(prompt)),
      ])) as AIMessage;
      return this._contentToString(aiMsg.content).trim();
    } catch (exc) {
      logger.error(`[${this.name}] summarizeMinutes 失败: ${String(exc)}`);
      return `(会议纪要生成失败: ${String(exc)})`;
    }
  }

  /**
   * 会议结束时每个 agent 调用：基于会议记录总结自己的工作；与本职无关则只输出「无」。
   * 纯 LLM 调用，返回 markdown 正文。失败返回占位文本而非抛出。
   */
  async summarizeWork(transcript: string): Promise<string> {
    const transcript_cleaned = cleanBadChars(transcript);
    const roleDesc = ROLE_DESCRIPTIONS[this.name] ?? this.name;
    const prompt =
      `下面是一次多角色团队会议的完整记录。请你作为${roleDesc}，基于会议内容，\n` +
      "总结你在本次需求中需要完成的具体工作 / 任务 / 行动项，用 markdown 列表或短段落输出。\n" +
      "重要：如果架构师提出的需求与你的职责无关、你没有需要做的事，就只输出两个字：无。\n" +
      "不要加标题。\n\n" +
      `=== 会议记录 ===\n${transcript_cleaned}`;
    try {
      const aiMsg = (await this._model.invoke([
        new SystemMessage(cleanBadChars(this.systemPrompt)),
        new HumanMessage(cleanBadChars(prompt)),
      ])) as AIMessage;
      return this._contentToString(aiMsg.content).trim();
    } catch (exc) {
      logger.error(`[${this.name}] summarizeWork 失败: ${String(exc)}`);
      return `(生成失败: ${String(exc)})`;
    }
  }
```

- [ ] **Step 2: 验证 Checkpoint — runtime 类型检查**

Run: `pnpm --filter @meetmind/runtime typecheck`
Expected: 通过，无类型错误。

---

## Task 2: 导出 buildAllAgents

**Files:**
- Modify: `apps/runtime/src/graph/builder.ts:39`

`meetingSummary` 模块要复用同一套 agent 构造逻辑，需把私有 `buildAllAgents` 导出。

- [ ] **Step 1: 给 buildAllAgents 加 export**

在 `apps/runtime/src/graph/builder.ts` 第 39 行，把：

```ts
/** 一次性 new 出 5 个角色 Agent 实例，返回 name → Agent 的字典。 */
function buildAllAgents(): Record<string, BaseAgent> {
```

改为：

```ts
/** 一次性 new 出 5 个角色 Agent 实例，返回 name → Agent 的字典。 */
export function buildAllAgents(): Record<string, BaseAgent> {
```

- [ ] **Step 2: 验证 Checkpoint — runtime 类型检查**

Run: `pnpm --filter @meetmind/runtime typecheck`
Expected: 通过。

---

## Task 3: meetingSummary 模块（纯函数 TDD + 整理主流程）

**Files:**
- Create: `apps/runtime/src/server/meetingSummary.ts`
- Test: `apps/runtime/src/server/meetingSummary.test.ts`

先 TDD 两个纯函数 `formatTranscript` / `composeSummaryMarkdown`，再补不可单测的 `getSummaryAgents` / `summarizeMeeting`。

- [ ] **Step 1: 写失败测试**

创建 `apps/runtime/src/server/meetingSummary.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { formatTranscript, composeSummaryMarkdown } from "./meetingSummary.js";
import type { AgentResponse } from "../agents/base.js";

describe("formatTranscript", () => {
  it("空数组返回空串", () => {
    expect(formatTranscript([])).toBe("");
  });

  it("把每条消息拼成【role】(agent)\\n正文，段间空行", () => {
    const messages: AgentResponse[] = [
      { agent_name: "user", role: "用户", message: "做个登录页", next_agent: "architect", done: false, used_rag: false },
      { agent_name: "architect", role: "架构师（项目老大）", message: "拆解如下", next_agent: "frontend", done: false, used_rag: false },
    ];
    const text = formatTranscript(messages);
    expect(text).toContain("【用户】(user)\n做个登录页");
    expect(text).toContain("【架构师（项目老大）】(architect)\n拆解如下");
    expect(text).toContain("\n\n");
  });
});

describe("composeSummaryMarkdown", () => {
  it("组装出带纪要 + 5 段工作的整份 markdown", () => {
    const works = [
      { role: "架构师 (Architect / Tech Lead)", body: "统筹与收尾" },
      { role: "后端工程师 (Backend Engineer)", body: "设计登录接口" },
      { role: "前端工程师 (Frontend Engineer)", body: "实现登录页" },
      { role: "测试工程师 (QA Engineer)", body: "无" },
      { role: "产品经理 (Product Manager)", body: "无" },
    ];
    const md = composeSummaryMarkdown("sess-123", "用户要求做登录功能。", works, "2026-06-03T10:00:00.000Z");
    expect(md).toContain("# 会议纪要");
    expect(md).toContain("> 会议 ID: sess-123");
    expect(md).toContain("> 生成时间: 2026-06-03T10:00:00.000Z");
    expect(md).toContain("## 一、会议纪要");
    expect(md).toContain("用户要求做登录功能。");
    expect(md).toContain("## 二、各 Agent 的工作");
    expect(md).toContain("### 后端工程师 (Backend Engineer)");
    expect(md).toContain("设计登录接口");
    expect(md).toContain("### 测试工程师 (QA Engineer)");
    // 「无」段落原样出现在测试工程师小节后
    const qaIndex = md.indexOf("### 测试工程师 (QA Engineer)");
    expect(md.slice(qaIndex)).toContain("无");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/meetingSummary.test.ts`
Expected: FAIL，报找不到模块 `./meetingSummary.js` 或导出 `formatTranscript` / `composeSummaryMarkdown`。

- [ ] **Step 3: 创建模块，先实现两个纯函数让测试通过**

创建 `apps/runtime/src/server/meetingSummary.ts`：

```ts
/**
 * 会议结束整理：架构师出一份会议纪要 + 各 agent 出本职工作段，
 * 组装成一份 markdown 写到 data/summary/{sessionId}.md，过程经 SSE 推进度。
 */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { AGENT_NAMES, ARCHITECT, ROLE_DESCRIPTIONS } from "../config/constants.js";
import { PROJECT_ROOT } from "../config/settings.js";
import type { AgentResponse, BaseAgent } from "../agents/base.js";
import { buildAllAgents } from "../graph/builder.js";
import * as chatStore from "../database/chatStore.js";
import * as sse from "./sse.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.meetingSummary");

/** 把整轮转录（含 user 轮）拼成纯文本喂给 LLM。 */
export function formatTranscript(messages: AgentResponse[]): string {
  if (messages.length === 0) {
    return "";
  }
  const chunks: string[] = [];
  for (const m of messages) {
    chunks.push(`【${m.role}】(${m.agent_name})\n${m.message}`);
  }
  return chunks.join("\n\n");
}

/** 纯函数：把会议纪要 + 各 agent 工作段组装成整份 markdown。generatedAt 由调用方传入以便单测。 */
export function composeSummaryMarkdown(
  sessionId: string,
  minutes: string,
  works: Array<{ role: string; body: string }>,
  generatedAt: string,
): string {
  const lines: string[] = [];
  lines.push("# 会议纪要");
  lines.push("");
  lines.push(`> 会议 ID: ${sessionId}`);
  lines.push(`> 生成时间: ${generatedAt}`);
  lines.push("");
  lines.push("## 一、会议纪要");
  lines.push("");
  lines.push(minutes.trim());
  lines.push("");
  lines.push("## 二、各 Agent 的工作");
  lines.push("");
  for (const work of works) {
    lines.push(`### ${work.role}`);
    lines.push("");
    lines.push(work.body.trim());
    lines.push("");
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/meetingSummary.test.ts`
Expected: PASS，2 个 describe 共 3 个用例全绿。

- [ ] **Step 5: 在同文件追加整理主流程（不可单测，靠 typecheck + 手动验证）**

在 `apps/runtime/src/server/meetingSummary.ts` 末尾追加：

```ts
/** 懒加载单例：与图各持一套无状态 agent，互不干扰；整理不走 RAG。 */
let _agents: Record<string, BaseAgent> | null = null;
function getSummaryAgents(): Record<string, BaseAgent> {
  if (!_agents) {
    _agents = buildAllAgents();
  }
  return _agents;
}

/**
 * 会议结束整理主流程：读消息 → 架构师纪要 → 各 agent 工作（逐个推 progress）→ 写单文件 → summary_done。
 * 自身 try/catch 包裹，失败 sse.send("summary_error")，绝不抛出（rpc 侧 .catch 仅二次兜底）。
 */
export async function summarizeMeeting(sessionId: string): Promise<void> {
  try {
    const messages = await chatStore.getMessages(sessionId);
    if (messages.length === 0) {
      sse.send(sessionId, "summary_error", { message: "本次会议尚无讨论内容，无法生成纪要" });
      return;
    }

    const transcript = formatTranscript(messages);
    const agents = getSummaryAgents();

    // 1) 架构师出一份共享会议纪要
    const architect = agents[ARCHITECT];
    const minutes = await architect.summarizeMinutes(transcript);

    // 2) 每个 agent 出自己的工作段，逐个推进度
    const works: Array<{ role: string; body: string }> = [];
    const total = AGENT_NAMES.length;
    let index = 0;
    for (const name of AGENT_NAMES) {
      index += 1;
      const role = ROLE_DESCRIPTIONS[name] ?? name;
      sse.send(sessionId, "summary_progress", { agent: name, role, index, total });
      const agent = agents[name];
      const body = await agent.summarizeWork(transcript);
      works.push({ role, body });
    }

    // 3) 组装并写单文件
    const generatedAt = new Date().toISOString();
    const md = composeSummaryMarkdown(sessionId, minutes, works, generatedAt);
    const dir = path.join(PROJECT_ROOT, "data", "summary");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.md`);
    await writeFile(file, md, "utf8");

    logger.info(`[meetingSummary] 会话 ${sessionId} 纪要已写入 ${file}`);
    sse.send(sessionId, "summary_done", { file });
  } catch (exc) {
    logger.error(`[meetingSummary] 会话 ${sessionId} 整理失败: ${String(exc)}`);
    sse.send(sessionId, "summary_error", { message: String(exc) });
  }
}
```

- [ ] **Step 6: 验证 Checkpoint — 类型检查 + 测试**

Run: `pnpm --filter @meetmind/runtime typecheck && pnpm --filter @meetmind/runtime exec vitest run src/server/meetingSummary.test.ts`
Expected: typecheck 通过；测试 PASS。

---

## Task 4: chat.end RPC + 测试

**Files:**
- Modify: `apps/runtime/src/server/rpc.ts`
- Test: `apps/runtime/src/server/rpc.test.ts`（追加 chat.end 用例 + mock meetingSummary）

- [ ] **Step 1: 在 rpc.test.ts 追加失败测试 + mock**

在 `apps/runtime/src/server/rpc.test.ts` 顶部，把现有 import 段（第 1-5 行）替换为下面这段（新增 mock 与 import）：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleRpc } from "./rpc.js";
import * as sessions from "./sessions.js";
import * as chatStore from "../database/chatStore.js";
import type { buildGraph } from "../graph/builder.js";

// chat.end 会在后台调 summarizeMeeting（内部跑 LLM）。单测里 mock 成 no-op，避免真调模型。
vi.mock("./meetingSummary.js", () => ({
  summarizeMeeting: vi.fn().mockResolvedValue(undefined),
}));
import * as meetingSummary from "./meetingSummary.js";
```

然后在 `describe("handleRpc", ...)` 内部、最后一个 `it("未知方法返回 -32601", ...)` 之前，插入：

```ts
  it("chat.end 缺 sessionId 返回 -32602", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 20,
      method: "chat.end",
      params: {},
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("chat.end busy 会话返回 -32000", async () => {
    sessions.setBusy("s1", true);
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 21,
      method: "chat.end",
      params: { sessionId: "s1" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32000);
  });

  it("chat.end 空闲时上锁、后台整理、回 ok", async () => {
    vi.mocked(meetingSummary.summarizeMeeting).mockClear();
    const setBusy = vi.spyOn(sessions, "setBusy");
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 22,
      method: "chat.end",
      params: { sessionId: "s1" },
    });
    expect(res).toMatchObject({ jsonrpc: "2.0", id: 22, result: { ok: true } });
    expect(setBusy).toHaveBeenCalledWith("s1", true);
    expect(meetingSummary.summarizeMeeting).toHaveBeenCalledWith("s1");
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/rpc.test.ts`
Expected: FAIL —「chat.end 缺 sessionId」会落到 `-32601`（未知方法）而非 `-32602`，「空闲时上锁」断言 `summarizeMeeting` 未被调用。

- [ ] **Step 3: 在 rpc.ts 加 import 与 chat.end 分支**

在 `apps/runtime/src/server/rpc.ts` 顶部 import 段（第 6 行 `import * as chatStore ...` 之后）追加：

```ts
import * as sse from "./sse.js";
import { summarizeMeeting } from "./meetingSummary.js";
```

然后在 `chat.interrupt` 分支之后（约第 80 行 `}` 之后）、`session.create` 分支之前，插入：

```ts
  // chat.end:结束会议——立即返回,后台让各 agent 整理会议纪要(仿 chat.send 不 await)。
  if (body.method === "chat.end") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    // 仅空闲时可结束;讨论进行中先打断再结束(服务端兜底,前端按钮也已置灰)。
    if (sessions.isBusy(sessionId)) {
      return rpcError(id, -32000, "讨论进行中,无法结束会议,请先打断");
    }
    // 上锁,防止整理期间又被 chat.send / 再次 chat.end 插入。
    sessions.setBusy(sessionId, true);
    // 不 await:整理很慢(6 次 LLM),HTTP 立即回 ok,进度/结果走 SSE。
    const running = summarizeMeeting(sessionId);
    running
      .catch((exc) => {
        console.error(`[rpc] summarizeMeeting 未捕获异常 (会话 ${sessionId}):`, exc);
        sse.send(sessionId, "summary_error", { message: String(exc) });
      })
      .finally(() => {
        sessions.setBusy(sessionId, false);
      });
    return rpcOk(id, { ok: true });
  }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @meetmind/runtime exec vitest run src/server/rpc.test.ts`
Expected: PASS，新增 3 个 chat.end 用例全绿，原有用例不受影响。

- [ ] **Step 5: 验证 Checkpoint — runtime 全量测试 + 类型检查**

Run: `pnpm --filter @meetmind/runtime test && pnpm --filter @meetmind/runtime typecheck`
Expected: 全部测试 PASS；typecheck 通过。

---

## Task 5: sseClient 新增 summary 三事件

**Files:**
- Modify: `apps/desktop/src/api/sseClient.ts`

- [ ] **Step 1: 追加 payload 类型 + handler 字段 + 监听器**

在 `apps/desktop/src/api/sseClient.ts` 的 `ErrorPayload` 定义（约第 15 行）之后追加：

```ts
// summary_progress:会议结束后,逐个 agent 整理纪要的进度。
export interface SummaryProgressPayload { agent: string; role: string; index: number; total: number }
// summary_done:会议纪要整理完成,file=生成的 markdown 文件路径。
export interface SummaryDonePayload { file: string }
// summary_error:整理纪要过程出错。
export interface SummaryErrorPayload { message: string }
```

在 `SseHandlers` 接口里、`onError` 之后追加三行：

```ts
  onSummaryProgress: (p: SummaryProgressPayload) => void;
  onSummaryDone: (p: SummaryDonePayload) => void;
  onSummaryError: (p: SummaryErrorPayload) => void;
```

在 `openEvents` 里现有 `es.addEventListener("error", ...)` 块之后、`return es;` 之前追加：

```ts
  es.addEventListener("summary_progress", (e) => {
    handlers.onSummaryProgress(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("summary_done", (e) => {
    handlers.onSummaryDone(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("summary_error", (e) => {
    handlers.onSummaryError(JSON.parse((e as MessageEvent).data));
  });
```

- [ ] **Step 2: 验证 Checkpoint**

说明：此时 `ChatWindow.vue` 还没提供这三个 handler，desktop typecheck 会在 ChatWindow 处报缺字段——这是预期的，Task 7 会补上。本步只确认 `sseClient.ts` 自身无语法错。

Run: `pnpm --filter @meetmind/desktop typecheck`
Expected: 仅 `ChatWindow.vue` 报 `onSummaryProgress` 等缺失（预期，Task 7 修复）；`sseClient.ts` 自身无错。若有其它文件报错需排查。

---

## Task 6: Composer 新增「结束」按钮

**Files:**
- Modify: `apps/desktop/src/components/Composer.vue`

- [ ] **Step 1: emit 增加 end 事件**

在 `apps/desktop/src/components/Composer.vue` 第 6 行，把：

```ts
const emit = defineEmits<{ send: [text: string]; interrupt: [] }>();
```

改为：

```ts
const emit = defineEmits<{ send: [text: string]; interrupt: []; end: [] }>();
```

- [ ] **Step 2: 模板加「结束」按钮**

在 `<template>` 里，现有发送/打断 `<button>` 的 `</button>`（约第 57 行）之后、`</div>` 之前，追加：

```html
    <button
      class="end"
      :disabled="busy"
      title="结束会议（仅空闲时可用）"
      @click="emit('end')"
    >
      结束
    </button>
```

- [ ] **Step 3: 加样式**

在 `<style scoped>` 末尾（`.square {...}` 之后）追加：

```css
/* 结束会议按钮:灰色,仅空闲可用 */
button.end { background: #6b7280; min-width: 56px; }
button.end:hover { background: #4b5563; }
button.end:disabled { opacity: 0.5; cursor: not-allowed; }
button.end:disabled:hover { background: #6b7280; }
```

- [ ] **Step 4: 验证 Checkpoint**

Run: `pnpm --filter @meetmind/desktop typecheck`
Expected: `Composer.vue` 自身无错（ChatWindow 仍可能因 Task 7 未做而报错，属预期）。

---

## Task 7: MeetingEndDialog 组件

**Files:**
- Create: `apps/desktop/src/components/MeetingEndDialog.vue`

- [ ] **Step 1: 创建弹窗组件**

创建 `apps/desktop/src/components/MeetingEndDialog.vue`：

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
import TypingDots from "./TypingDots.vue";

// 会议结束弹窗:整理中显示进度+转圈(不可关闭);完成/出错后显示结果+关闭按钮。
const props = defineProps<{
  status: "summarizing" | "done" | "error";
  message: string;
  detail?: string;
}>();

const emit = defineEmits<{ close: [] }>();

// 整理中不允许关闭,强制用户等结果。
function tryClose(): void {
  if (props.status !== "summarizing") {
    emit("close");
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    tryClose();
  }
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="overlay" @click="tryClose">
    <div class="dialog" @click.stop>
      <h2 class="title">会议已结束</h2>

      <div v-if="status === 'summarizing'" class="body">
        <p class="message">{{ message }}</p>
        <div class="progress">
          <span v-if="detail" class="detail">{{ detail }}</span>
          <TypingDots />
        </div>
      </div>

      <div v-else-if="status === 'done'" class="body">
        <p class="message">✓ {{ message }}</p>
        <p v-if="detail" class="detail file">{{ detail }}</p>
      </div>

      <div v-else class="body">
        <p class="message err">✗ {{ message }}</p>
      </div>

      <div v-if="status !== 'summarizing'" class="actions">
        <button class="btn confirm" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 复用 ConfirmDialog 的深色弹窗风格 */
.overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.dialog { width: min(440px, calc(100vw - 48px)); background: #2c2c2e; color: #f5f5f7; border-radius: 16px; padding: 24px 24px 18px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45); }
.title { margin: 0 0 12px; font-size: 22px; font-weight: 700; }
.body { margin-bottom: 18px; }
.message { margin: 0 0 12px; font-size: 15px; line-height: 1.5; color: #f5f5f7; }
.message.err { color: #ff6b6b; }
.progress { display: flex; align-items: center; gap: 10px; color: #c7c7cc; }
.detail { font-size: 13px; color: #c7c7cc; }
.detail.file { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #9ca3af; }
.actions { display: flex; justify-content: flex-end; gap: 10px; }
.btn { padding: 9px 18px; border: none; border-radius: 9px; font-size: 14px; font-weight: 600; cursor: pointer; }
.confirm { background: #4f46e5; color: #fff; }
.confirm:hover { background: #4338ca; }
</style>
```

- [ ] **Step 2: 验证 Checkpoint**

Run: `pnpm --filter @meetmind/desktop typecheck`
Expected: `MeetingEndDialog.vue` 自身无错（ChatWindow 仍因 Task 7 未接线报错，属预期，下一 Task 修复）。

---

## Task 8: ChatWindow 接线（结束按钮 + summary SSE + 弹窗）

**Files:**
- Modify: `apps/desktop/src/components/ChatWindow.vue`

本 Task 完成后 desktop typecheck 应整体通过（补齐 Task 5 要求的三个 handler）。

- [ ] **Step 1: import 弹窗组件 + ref**

在 `apps/desktop/src/components/ChatWindow.vue` 的 import 段，`import Composer from "./Composer.vue";`（约第 8 行）之后追加：

```ts
import MeetingEndDialog from "./MeetingEndDialog.vue";
```

在 `const scroller = ref<HTMLElement | null>(null);`（约第 16 行）之后追加 summary 状态：

```ts
// 会议结束整理弹窗状态(单会话 demo,弹窗为全屏模态,整理中不能切会话,共用一个 ref 足够)。
const summary = ref<{
  open: boolean;
  status: "summarizing" | "done" | "error";
  message: string;
  detail: string;
}>({ open: false, status: "summarizing", message: "", detail: "" });
```

- [ ] **Step 2: connect() 里补三个 SSE handler**

在 `connect()` 的 `openEvents(sessionId, {...})` 对象里，`onError: (p) => chat.addErrorBubble(sessionId, p.message),`（约第 50 行）之后追加：

```ts
    onSummaryProgress: (p) => {
      summary.value.detail = `正在整理:${p.role}(${p.index}/${p.total})`;
    },
    onSummaryDone: (p) => {
      summary.value.status = "done";
      summary.value.message = "会议纪要已生成";
      summary.value.detail = p.file;
    },
    onSummaryError: (p) => {
      summary.value.status = "error";
      summary.value.message = p.message;
    },
```

- [ ] **Step 3: 加 onEnd 处理函数**

在 `onInterrupt` 函数（约第 101-107 行）之后追加：

```ts
// 结束会议:弹出整理中弹窗,调 chat.end;后续进度/结果由 SSE 的 summary_* 事件驱动弹窗更新。
async function onEnd(): Promise<void> {
  summary.value = {
    open: true,
    status: "summarizing",
    message: "当前会议已结束,正在整理会议纪要",
    detail: "",
  };
  try {
    await rpc("chat.end", { sessionId: props.sessionId });
  } catch (e) {
    summary.value.status = "error";
    summary.value.message = String(e);
  }
}
```

- [ ] **Step 4: 模板挂 @end 与弹窗**

把模板里的：

```html
    <Composer :busy="busy" @send="onSend" @interrupt="onInterrupt" />
```

改为：

```html
    <Composer :busy="busy" @send="onSend" @interrupt="onInterrupt" @end="onEnd" />
    <MeetingEndDialog
      v-if="summary.open"
      :status="summary.status"
      :message="summary.message"
      :detail="summary.detail"
      @close="summary.open = false"
    />
```

- [ ] **Step 5: 验证 Checkpoint — desktop 全量类型检查**

Run: `pnpm --filter @meetmind/desktop typecheck`
Expected: **整体通过**，无错误（Task 5/6/7 遗留的「预期报错」此时全部消除）。

---

## Task 9: 端到端手动验证

**Files:** 无（仅运行验证）

- [ ] **Step 1: 起服务**

确保本地 PostgreSQL 已起（`docker compose up -d`）。两个终端分别运行：

```bash
pnpm dev:runtime
```
```bash
pnpm dev:desktop
```
（runtime 在 3002，desktop vite 在 5173，`/api`、`/events` 已代理到 3002。）

- [ ] **Step 2: 跑一轮讨论再结束**

1. 浏览器开 `http://localhost:5173`。
2. 新建会话，发送一条真实需求（如「做一个用户登录功能」），等架构师等若干 agent 发言、本轮结束（busy 解除）。
3. 确认「结束」按钮此时可点（讨论进行中应置灰）。
4. 点「结束」。

Expected:
- 立刻弹出「当前会议已结束，正在整理会议纪要」+ 转圈，逐步显示「正在整理：架构师 (Architect / Tech Lead)（1/5）…」直到（5/5）。
- 整理完成弹窗变「✓ 会议纪要已生成」并显示文件路径，出现「关闭」按钮。

- [ ] **Step 3: 核对生成的文件**

Run: `ls -la data/summary/ && cat data/summary/*.md`
Expected: 有一个 `{sessionId}.md`，内容含「# 会议纪要」「## 一、会议纪要」（架构师纪要正文）「## 二、各 Agent 的工作」及 5 个 `### {角色}` 小节；与需求无关的角色其工作段为「无」。

- [ ] **Step 4: 边界验证（可选）**

- 在空会话（无任何消息）点「结束」→ 弹窗应显示「✗ 本次会议尚无讨论内容，无法生成纪要」+ 关闭按钮。
- 讨论进行中（busy）时「结束」按钮置灰、不可点。

- [ ] **Step 5: 完成**

全部通过即实现完成。是否提交由用户决定（本项目不主动 commit）。

---

## 自检对照（Self-Review）

- **Spec 覆盖**：结束按钮(Task 6) / 仅空闲可用(Task 4 -32000 + Task 6 :disabled) / 弹窗进度→完成(Task 7+8) / chat.end 立即返回后台整理(Task 4) / 架构师纪要 + 各 agent 工作(Task 1+3) / 单文件 `data/summary/{sessionId}.md`(Task 3) / markdown 格式(Task 3 composeSummaryMarkdown) / SSE 三事件(Task 3 发、Task 5 收) / 错误与边界(Task 3 + Task 9) / 单测(Task 3+4)。全部有对应 Task。
- **类型/命名一致**：`summarizeMinutes` / `summarizeWork` / `summarizeMeeting` / `composeSummaryMarkdown` / `formatTranscript` / `getSummaryAgents` 跨 Task 一致；SSE 事件名 `summary_progress` / `summary_done` / `summary_error` 收发两端一致；payload 字段 `{agent,role,index,total}` / `{file}` / `{message}` 一致；`buildAllAgents` 导出后被 meetingSummary 引用。
- **无占位符**：每个改动步骤都给了完整代码与确切命令/预期。
