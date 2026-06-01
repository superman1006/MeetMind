# 桌面前端 + Monorepo 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 CLI 版多 Agent RAG 系统改造成 pnpm monorepo（`apps/runtime` 引擎+HTTP/SSE 服务 + `apps/desktop` Tauri2/Vue3 前端），前端通过 JSON-RPC `/api` 触发讨论、SSE `/events` 接收 agent 的真·LLM-token 流式回复。

**Architecture:** runtime 把 `graph.stream` 包成服务：节点用 LangGraph `config.writer` 发自定义流事件（turn_start/delta/turn_end），`BaseAgent.invoke` Phase 2 改 `.stream()` 逐段吐 `content` 增量；服务端用双模式 `streamMode:["custom","values"]` 把自定义事件转发成 SSE，`values` 末帧更新内存会话记忆。前端 Pinia 管会话/消息，EventSource 接 SSE 逐字渲染气泡。

**Tech Stack:** TypeScript (ESM/NodeNext)、@langchain/langgraph 0.2.74、Node 内置 `http`（不引 express）、vitest（runtime 测试）、Vue 3 + Vite + Pinia + Tauri 2。

**全局约束（每个 task 都适用）：**
- 相对 import 一律带 `.js` 后缀（ESM/NodeNext 硬要求）。
- 注释用中文，保留仓库既有 snake_case 字段名（`next_agent`/`agent_name`/`used_rag`/`done`）。
- 禁止数组方法链做数据管道、禁止多层链式调用、中间结果必须命名（见 CLAUDE.md 编码风格）。
- 每个 task 末尾 commit。

---

## 文件结构总览

```
apps/runtime/src/
  agents/ graph/ database/ tools/ config/ utils/  cli/   ← 从 src/ 整体迁入(import 不变)
  agents/streamStructured.ts        ← 新增:流式结构化输出的 content diff 辅助
  graph/streamEvents.ts             ← 新增:节点自定义流事件类型
  server/sessions.ts                ← 新增:内存会话 + busy 标记
  server/sse.ts                     ← 新增:SSE 连接管理 + send
  server/runDiscussion.ts           ← 新增:graph.stream 双模式 → SSE
  server/rpc.ts                     ← 新增:JSON-RPC 分发
  server/httpServer.ts              ← 新增:node http 服务(/api /events + CORS)
  bootstrap.ts                      ← 新增:从 cli/main.ts 抽出的自检+灌库
  index.ts                          ← 改:dotenv → bootstrap → 起服务
apps/desktop/
  index.html  vite.config.ts  package.json  tsconfig.json
  src/main.ts  src/App.vue
  src/api/rpcClient.ts  src/api/sseClient.ts
  src/stores/sessions.ts  src/stores/chat.ts
  src/theme/agentColors.ts
  src/components/{SessionList,ChatWindow,MessageBubble,Composer}.vue
  src-tauri/                        ← Task 15: 装 Rust 后 tauri init 生成
```

---

## Task 1: Monorepo 骨架 + 迁移 runtime（不改行为）

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`（根，瘦身为编排）
- Create: `tsconfig.base.json`
- Move: `src/` → `apps/runtime/src/`（整树 git mv）
- Create: `apps/runtime/package.json`、`apps/runtime/tsconfig.json`
- Modify: `apps/runtime/src/config/settings.ts:15`（PROJECT_ROOT 上移 4 级）

- [ ] **Step 1: 创建 runtime 目录并整树迁移 src**

```bash
mkdir -p apps/runtime
git mv src apps/runtime/src
```

- [ ] **Step 2: 修复 PROJECT_ROOT（从 4 级父目录解析到仓库根）**

`apps/runtime/src/config/settings.ts` 第 15 行原为：
```ts
// settings.ts 位于 src/config/settings.ts，向上两级是项目根
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
```
改为：
```ts
// settings.ts 现位于 apps/runtime/src/config/settings.ts（编译后 dist 同深度），
// 向上四级 config→src→runtime→apps 才是仓库根（data/ models/ .env 都在根，两个 app 共享）
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
```

- [ ] **Step 3: 写 `apps/runtime/package.json`（把原根依赖搬来 + 加 vitest）**

```json
{
  "name": "@meetmind/runtime",
  "version": "0.2.0",
  "description": "MeetMind 引擎 + HTTP/SSE 服务",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx src/index.ts",
    "dev:cli": "tsx src/cli/main.ts",
    "build": "tsc -p .",
    "start:prod": "node dist/index.js",
    "typecheck": "tsc -p . --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@huggingface/transformers": "^3.0.0",
    "@langchain/core": "^0.3.0",
    "@langchain/langgraph": "^0.2.0",
    "@langchain/openai": "^0.3.0",
    "@langchain/textsplitters": "^0.1.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "boxen": "^8.0.1",
    "chalk": "^5.3.0",
    "cli-table3": "^0.6.5",
    "cohere-ai": "^7.14.0",
    "dotenv": "^16.4.5",
    "mammoth": "^1.8.0",
    "ora": "^8.1.0",
    "pdfjs-dist": "^4.7.76",
    "pg": "^8.13.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 4: 抽出 `tsconfig.base.json`（仓库根）**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "customConditions": ["node"],
    "lib": ["ES2022"],
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "sourceMap": true,
    "noUncheckedIndexedAccess": false
  }
}
```

- [ ] **Step 5: 写 `apps/runtime/tsconfig.json`（extends base）**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

- [ ] **Step 6: 删除仓库根旧 `tsconfig.json`**

```bash
git rm tsconfig.json
```

- [ ] **Step 7: 改 `pnpm-workspace.yaml` 加 packages**

```yaml
packages:
  - "apps/*"

allowBuilds:
  esbuild: true
  onnxruntime-node: true
  protobufjs: true
  sharp: true
```

- [ ] **Step 8: 根 `package.json` 瘦身为编排（依赖已下放到 runtime）**

```json
{
  "name": "meetmind-monorepo",
  "version": "0.2.0",
  "description": "Multi-agent RAG collaboration system (monorepo: runtime + desktop)",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "dev:runtime": "pnpm --filter @meetmind/runtime dev",
    "dev:desktop": "pnpm --filter @meetmind/desktop dev",
    "dev:cli": "pnpm --filter @meetmind/runtime dev:cli",
    "typecheck": "pnpm -r typecheck",
    "build": "pnpm -r build",
    "test": "pnpm -r test"
  }
}
```

- [ ] **Step 9: 重新安装并验证 CLI 仍可类型检查通过**

Run: `pnpm install && pnpm --filter @meetmind/runtime typecheck`
Expected: 安装成功；typecheck 无错误输出（exit 0）。

- [ ] **Step 10: 手动确认 CLI 仍能起到「等待输入」那一步（PROJECT_ROOT/种子路径正确）**

Run: `pnpm --filter @meetmind/runtime dev:cli`
Expected: 打印 banner，PostgreSQL 就绪，**扫描种子目录能列出各 agent 文件**（证明 PROJECT_ROOT 正确解析到仓库根），到「架构师，请输入项目需求」提示符。按 Ctrl+C 退出。
（若提示种子目录不存在，说明 PROJECT_ROOT 没指对，回 Step 2 检查层级。）

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor: 迁移到 monorepo, src → apps/runtime, 修复 PROJECT_ROOT"
```

---

## Task 2: runtime 接入 vitest（测试基建）

**Files:**
- Create: `apps/runtime/vitest.config.ts`
- Create: `apps/runtime/src/server/sanity.test.ts`

- [ ] **Step 1: 写 vitest 配置**

`apps/runtime/vitest.config.ts`：
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 2: 写一个最小通过测试**

`apps/runtime/src/server/sanity.test.ts`：
```ts
import { describe, it, expect } from "vitest";

describe("sanity", () => {
  it("vitest 跑得起来", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 3: 运行测试，确认通过**

Run: `pnpm --filter @meetmind/runtime test`
Expected: 1 passed。

- [ ] **Step 4: Commit**

```bash
git add apps/runtime/vitest.config.ts apps/runtime/src/server/sanity.test.ts
git commit -m "test: runtime 接入 vitest"
```

---

## Task 3: 流式结构化输出的 content-diff 辅助（TDD）

提取一个纯函数，从「逐帧长大的 partial 对象流」里 diff 出 `content` 增量并回调，便于单测且复用进 invoke。

**Files:**
- Create: `apps/runtime/src/agents/streamStructured.ts`
- Test: `apps/runtime/src/agents/streamStructured.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/runtime/src/agents/streamStructured.test.ts`：
```ts
import { describe, it, expect } from "vitest";
import { streamStructuredContent } from "./streamStructured.js";

async function* fakeStream(chunks: Array<{ content?: string }>) {
  for (const c of chunks) {
    yield c;
  }
}

describe("streamStructuredContent", () => {
  it("逐帧吐出 content 增量, 返回最后一帧", async () => {
    const deltas: string[] = [];
    const last = await streamStructuredContent(
      fakeStream([
        { content: "你" },
        { content: "你好" },
        { content: "你好世界", done: "true" } as { content?: string },
      ]),
      (t) => deltas.push(t),
    );
    expect(deltas).toEqual(["你", "好", "世界"]);
    expect(last.content).toBe("你好世界");
  });

  it("后端只吐一帧时退化成一段大 delta", async () => {
    const deltas: string[] = [];
    await streamStructuredContent(fakeStream([{ content: "整段一次到达" }]), (t) =>
      deltas.push(t),
    );
    expect(deltas).toEqual(["整段一次到达"]);
  });

  it("content 早期为 undefined 时不回调", async () => {
    const deltas: string[] = [];
    await streamStructuredContent(fakeStream([{}, { content: "x" }]), (t) =>
      deltas.push(t),
    );
    expect(deltas).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meetmind/runtime test streamStructured`
Expected: FAIL（找不到 `./streamStructured.js`）。

- [ ] **Step 3: 写实现**

`apps/runtime/src/agents/streamStructured.ts`：
```ts
/**
 * 从「逐帧长大的 partial 结构化对象」流里 diff 出 content 增量。
 *
 * withStructuredOutput(...).stream() 在 OpenAI 兼容后端上理想情况会逐帧吐出
 * content 不断变长的 partial；diff 出新增那截回调给 onDelta 实现真·token 打字机。
 * 若后端只在最后吐一整帧（结构化流式偶发不稳），自然退化成一段大 delta，结果仍正确。
 */
export interface ContentPartial {
  content?: string;
}

export async function streamStructuredContent<T extends ContentPartial>(
  stream: AsyncIterable<Partial<T>>,
  onDelta: (text: string) => void,
): Promise<Partial<T>> {
  let emitted = "";
  let last: Partial<T> = {};
  for await (const chunk of stream) {
    last = chunk;
    const content = chunk?.content;
    if (typeof content === "string" && content.length > emitted.length) {
      const increment = content.slice(emitted.length);
      onDelta(increment);
      emitted = content;
    }
  }
  return last;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @meetmind/runtime test streamStructured`
Expected: 3 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/agents/streamStructured.ts apps/runtime/src/agents/streamStructured.test.ts
git commit -m "feat: streamStructuredContent content-diff 辅助"
```

---

## Task 4: BaseAgent.invoke 接 onDelta（Phase 2 流式）

**Files:**
- Modify: `apps/runtime/src/agents/base.ts`（invoke 签名 + Phase 2 分支）

- [ ] **Step 1: invoke 增加可选 opts 参数**

`apps/runtime/src/agents/base.ts` 中 `invoke` 签名（约第 179-182 行）：
```ts
  async invoke(
    requirement: string,
    conversationHistory: string,
  ): Promise<AgentResponse> {
```
改为：
```ts
  async invoke(
    requirement: string,
    conversationHistory: string,
    opts?: { onDelta?: (text: string) => void },
  ): Promise<AgentResponse> {
```

- [ ] **Step 2: 顶部加 import**

在 base.ts 现有 import 区加：
```ts
import { streamStructuredContent } from "./streamStructured.js";
```

- [ ] **Step 3: Phase 2 改成「有 onDelta 走 stream，否则走 invoke」**

把现有 Phase 2 调用块（约第 274-284 行）：
```ts
    let finalOutput: ModelOutput;
    try {
      finalOutput = await structuredModel.invoke(Allmessages);
    } catch (exc) {
      logger.error(`[${this.name}] Phase 2 结构化收尾失败: ${String(exc)}`);
      finalOutput = {
        content: `(结构化输出失败: ${String(exc)})`,
        next_agent: ARCHITECT,
        done: "false",
      };
    }
```
改为：
```ts
    let finalOutput: ModelOutput;
    try {
      if (opts?.onDelta) {
        // 服务端路径:流式收尾,逐段吐 content 增量(真·token 打字机)
        const partialStream = await structuredModel.stream(Allmessages);
        const lastPartial = await streamStructuredContent<ModelOutput>(
          partialStream as AsyncIterable<Partial<ModelOutput>>,
          opts.onDelta,
        );
        finalOutput = lastPartial as ModelOutput;
      } else {
        // CLI 路径:一次拿完整结果,行为不变
        finalOutput = await structuredModel.invoke(Allmessages);
      }
    } catch (exc) {
      logger.error(`[${this.name}] Phase 2 结构化收尾失败: ${String(exc)}`);
      finalOutput = {
        content: `(结构化输出失败: ${String(exc)})`,
        next_agent: ARCHITECT,
        done: "false",
      };
    }
```

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @meetmind/runtime typecheck`
Expected: 无错误（exit 0）。

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/agents/base.ts
git commit -m "feat: BaseAgent.invoke 支持 onDelta 流式收尾"
```

---

## Task 5: 节点自定义流事件类型 + createNode 发事件

**Files:**
- Create: `apps/runtime/src/graph/streamEvents.ts`
- Modify: `apps/runtime/src/graph/builder.ts`（createNode 签名 + 发事件）

- [ ] **Step 1: 定义节点流事件类型**

`apps/runtime/src/graph/streamEvents.ts`：
```ts
/**
 * 节点通过 config.writer 发出的自定义流事件。
 * runDiscussion 用 streamMode:["custom","values"] 接到后按 kind 直接转发成 SSE 同名事件。
 */
export type NodeStreamChunk =
  | { kind: "turn_start"; turnId: string; agent_name: string; role: string }
  | { kind: "delta"; turnId: string; text: string }
  | {
      kind: "turn_end";
      turnId: string;
      next_agent: string | null;
      done: boolean;
      used_rag: boolean;
    };
```

- [ ] **Step 2: builder.ts 顶部加 import**

`apps/runtime/src/graph/builder.ts` import 区加：
```ts
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
```
（`END`/`START`/`StateGraph` 已从 `@langchain/langgraph` import，这里追加类型 import 即可。）

- [ ] **Step 3: 重写 createNode 接 config 并发事件**

把 builder.ts 现有 `createNode`（约第 60-86 行）整体替换为：
```ts
/** 把一个 BaseAgent 包成 LangGraph 节点函数：读 state → 发 turn_start → 调 agent.invoke(流式) → 发 turn_end → 返回增量 state。 */
function createNode(agent: BaseAgent) {
  return async (
    state: AgentState,
    config: LangGraphRunnableConfig,
  ): Promise<Partial<AgentState>> => {
    const requirement = state.requirement ?? "";
    const history = formatHistory(state.messages ?? []); // 历史发言拼成文本喂给 agent
    const iteration = (state.iteration ?? 0) + 1; // 轮次 +1，供安全阀判断
    const turnId = `${agent.name}-${iteration}`;

    logger.info(`[graph] iteration=${iteration}  →  invoking ${agent.name}_node`);

    // 有 writer(服务端流式)才发事件 + 传 onDelta；无 writer(CLI)则保持原非流式行为
    const writer = config.writer;
    if (writer) {
      writer({ kind: "turn_start", turnId, agent_name: agent.name, role: agent.role });
    }

    let onDelta: ((text: string) => void) | undefined = undefined;
    if (writer) {
      onDelta = (text: string) => {
        writer({ kind: "delta", turnId, text });
      };
    }

    let response;
    if (onDelta) {
      response = await agent.invoke(requirement, history, { onDelta });
    } else {
      response = await agent.invoke(requirement, history);
    }

    printAgentInfo({
      agentName: response.agent_name,
      message: response.message,
      nextRole: response.done ? "DONE" : response.next_agent,
      usedRag: response.used_rag,
    });

    if (writer) {
      writer({
        kind: "turn_end",
        turnId,
        next_agent: response.next_agent,
        done: response.done,
        used_rag: response.used_rag,
      });
    }

    // 只回增量：messages 追加（整条 AgentResponse 直接进历史），其余字段覆盖进 State
    return {
      messages: [response],
      next_agent: response.next_agent,
      done: response.done,
      iteration,
    };
  };
}
```

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @meetmind/runtime typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/graph/streamEvents.ts apps/runtime/src/graph/builder.ts
git commit -m "feat: 节点通过 config.writer 发 turn/delta 流事件"
```

---

## Task 6: 内存会话表 sessions.ts（TDD）

**Files:**
- Create: `apps/runtime/src/server/sessions.ts`
- Test: `apps/runtime/src/server/sessions.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/runtime/src/server/sessions.test.ts`：
```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  getMessages,
  replaceMessages,
  resetSession,
  isBusy,
  setBusy,
} from "./sessions.js";
import type { AgentResponse } from "../agents/base.js";

function turn(message: string): AgentResponse {
  return {
    agent_name: "architect",
    role: "架构师",
    message,
    next_agent: "architect",
    done: false,
    used_rag: false,
  };
}

describe("sessions", () => {
  beforeEach(() => {
    resetSession("s1");
    setBusy("s1", false);
  });

  it("未知会话返回空数组", () => {
    expect(getMessages("nope")).toEqual([]);
  });

  it("replace 后能取回", () => {
    replaceMessages("s1", [turn("hi")]);
    expect(getMessages("s1")).toHaveLength(1);
    expect(getMessages("s1")[0].message).toBe("hi");
  });

  it("reset 清空", () => {
    replaceMessages("s1", [turn("hi")]);
    resetSession("s1");
    expect(getMessages("s1")).toEqual([]);
  });

  it("busy 标记可置位/清位", () => {
    expect(isBusy("s1")).toBe(false);
    setBusy("s1", true);
    expect(isBusy("s1")).toBe(true);
    setBusy("s1", false);
    expect(isBusy("s1")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meetmind/runtime test sessions`
Expected: FAIL（找不到 `./sessions.js`）。

- [ ] **Step 3: 写实现**

`apps/runtime/src/server/sessions.ts`：
```ts
/**
 * 内存会话表：按 sessionId 存累计的 messages(跨轮记忆) + busy 标记(同会话串行)。
 * 无持久化:进程重启即丢(符合 demo 需求)。
 */
import type { AgentResponse } from "../agents/base.js";

const messagesBySession = new Map<string, AgentResponse[]>();
const busySessions = new Set<string>();

/** 取某会话累计的发言历史；未知会话返回空数组。 */
export function getMessages(sessionId: string): AgentResponse[] {
  const existing = messagesBySession.get(sessionId);
  if (existing) {
    return existing;
  }
  return [];
}

/** 用一轮结束后的全量 messages 覆盖回会话记忆。 */
export function replaceMessages(sessionId: string, messages: AgentResponse[]): void {
  messagesBySession.set(sessionId, messages);
}

/** 清空某会话记忆。 */
export function resetSession(sessionId: string): void {
  messagesBySession.delete(sessionId);
}

/** 该会话是否正在跑讨论。 */
export function isBusy(sessionId: string): boolean {
  return busySessions.has(sessionId);
}

/** 置位/清位 busy 标记。 */
export function setBusy(sessionId: string, busy: boolean): void {
  if (busy) {
    busySessions.add(sessionId);
  } else {
    busySessions.delete(sessionId);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @meetmind/runtime test sessions`
Expected: 4 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/server/sessions.ts apps/runtime/src/server/sessions.test.ts
git commit -m "feat: 内存会话表 sessions"
```

---

## Task 7: SSE 连接管理 sse.ts（TDD）

**Files:**
- Create: `apps/runtime/src/server/sse.ts`
- Test: `apps/runtime/src/server/sse.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/runtime/src/server/sse.test.ts`：
```ts
import { describe, it, expect } from "vitest";
import { addClient, removeClient, send } from "./sse.js";
import type { ServerResponse } from "node:http";

/** 造一个只捕获 write 内容的假 ServerResponse。 */
function fakeRes() {
  const writes: string[] = [];
  const res = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as ServerResponse;
  return { res, writes };
}

describe("sse", () => {
  it("send 把 event/data 按 SSE 帧写给该会话的所有连接", () => {
    const a = fakeRes();
    const b = fakeRes();
    addClient("s1", a.res);
    addClient("s1", b.res);
    send("s1", "delta", { turnId: "architect-1", text: "你好" });
    const expected = `event: delta\ndata: ${JSON.stringify({ turnId: "architect-1", text: "你好" })}\n\n`;
    expect(a.writes).toEqual([expected]);
    expect(b.writes).toEqual([expected]);
  });

  it("移除连接后不再收到", () => {
    const a = fakeRes();
    addClient("s2", a.res);
    removeClient("s2", a.res);
    send("s2", "round_done", { done: true });
    expect(a.writes).toEqual([]);
  });

  it("未知会话 send 不抛错", () => {
    expect(() => send("ghost", "delta", { x: 1 })).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meetmind/runtime test sse`
Expected: FAIL（找不到 `./sse.js`）。

- [ ] **Step 3: 写实现**

`apps/runtime/src/server/sse.ts`：
```ts
/**
 * SSE 连接管理:按 sessionId 维护一组打开的 ServerResponse,send 把事件写成 SSE 帧。
 */
import type { ServerResponse } from "node:http";

const clientsBySession = new Map<string, Set<ServerResponse>>();

/** 登记一个 SSE 长连接到某会话。 */
export function addClient(sessionId: string, res: ServerResponse): void {
  let set = clientsBySession.get(sessionId);
  if (!set) {
    set = new Set<ServerResponse>();
    clientsBySession.set(sessionId, set);
  }
  set.add(res);
}

/** 连接关闭时移除。 */
export function removeClient(sessionId: string, res: ServerResponse): void {
  const set = clientsBySession.get(sessionId);
  if (!set) {
    return;
  }
  set.delete(res);
  if (set.size === 0) {
    clientsBySession.delete(sessionId);
  }
}

/** 向某会话所有连接推一条 SSE 事件;未知会话静默忽略。 */
export function send(sessionId: string, event: string, data: unknown): void {
  const set = clientsBySession.get(sessionId);
  if (!set) {
    return;
  }
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    res.write(payload);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @meetmind/runtime test sse`
Expected: 3 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/server/sse.ts apps/runtime/src/server/sse.test.ts
git commit -m "feat: SSE 连接管理 sse"
```

---

## Task 8: runDiscussion —— graph.stream 双模式 → SSE（TDD）

**Files:**
- Create: `apps/runtime/src/server/runDiscussion.ts`
- Test: `apps/runtime/src/server/runDiscussion.test.ts`

- [ ] **Step 1: 写失败测试（用假 graph + 假 sse 验证转发与记忆更新）**

`apps/runtime/src/server/runDiscussion.test.ts`：
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDiscussion } from "./runDiscussion.js";
import * as sse from "./sse.js";
import * as sessions from "./sessions.js";
import type { AgentResponse } from "../agents/base.js";

function archTurn(message: string): AgentResponse {
  return {
    agent_name: "architect",
    role: "架构师",
    message,
    next_agent: "architect",
    done: true,
    used_rag: false,
  };
}

/** 造一个假 graph:stream() 返回 [mode, chunk] 元组的异步迭代器。 */
function fakeGraph(finalMessages: AgentResponse[]) {
  return {
    async stream() {
      async function* gen() {
        yield ["custom", { kind: "turn_start", turnId: "architect-1", agent_name: "architect", role: "架构师" }];
        yield ["custom", { kind: "delta", turnId: "architect-1", text: "好" }];
        yield ["custom", { kind: "turn_end", turnId: "architect-1", next_agent: "architect", done: true, used_rag: false }];
        yield ["values", { requirement: "x", messages: finalMessages, next_agent: "architect", done: true, iteration: 1 }];
      }
      return gen();
    },
  } as unknown as Parameters<typeof runDiscussion>[0];
}

describe("runDiscussion", () => {
  beforeEach(() => {
    sessions.resetSession("s1");
    sessions.setBusy("s1", false);
  });

  it("custom 帧转发成 SSE, values 末帧更新记忆, 最后发 round_done", async () => {
    const sent: Array<{ event: string; data: unknown }> = [];
    const spy = vi.spyOn(sse, "send").mockImplementation((_sid, event, data) => {
      sent.push({ event, data });
    });

    const finalMessages = [archTurn("最终结论")];
    await runDiscussion(fakeGraph(finalMessages), "s1", "做个登录页");

    const eventNames = sent.map((s) => s.event);
    expect(eventNames).toEqual(["turn_start", "delta", "turn_end", "round_done"]);
    // 会话记忆被末帧 messages 覆盖
    expect(sessions.getMessages("s1")).toHaveLength(1);
    expect(sessions.getMessages("s1")[0].message).toBe("最终结论");

    spy.mockRestore();
  });

  it("seedMessages 含用户输入作为起点(跨轮记忆)", async () => {
    // 先放一条历史
    sessions.replaceMessages("s1", [archTurn("上一轮")]);
    let capturedSeed: AgentResponse[] = [];
    const graph = {
      async stream(initial: { messages: AgentResponse[] }) {
        capturedSeed = initial.messages;
        async function* gen() {
          yield ["values", { messages: initial.messages, done: true }];
        }
        return gen();
      },
    } as unknown as Parameters<typeof runDiscussion>[0];

    await runDiscussion(graph, "s1", "第二轮需求");
    // 起点 = 上一轮历史 + 本轮 user 输入
    expect(capturedSeed).toHaveLength(2);
    expect(capturedSeed[0].message).toBe("上一轮");
    expect(capturedSeed[1].agent_name).toBe("user");
    expect(capturedSeed[1].message).toBe("第二轮需求");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meetmind/runtime test runDiscussion`
Expected: FAIL（找不到 `./runDiscussion.js`）。

- [ ] **Step 3: 写实现**

`apps/runtime/src/server/runDiscussion.ts`：
```ts
/**
 * 跑一轮讨论并把过程推成 SSE：
 *   取会话历史 → 拼 userTurn → graph.stream(["custom","values"]) →
 *   custom 帧转发成 SSE 同名事件, values 末帧更新会话记忆 → round_done。
 */
import { ARCHITECT } from "../config/constants.js";
import type { AgentResponse } from "../agents/base.js";
import type { AgentState } from "../graph/state.js";
import type { NodeStreamChunk } from "../graph/streamEvents.js";
import type { buildGraph } from "../graph/builder.js";
import * as sse from "./sse.js";
import * as sessions from "./sessions.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.runDiscussion");

type CompiledGraph = ReturnType<typeof buildGraph>;

export async function runDiscussion(
  graph: CompiledGraph,
  sessionId: string,
  requirement: string,
): Promise<void> {
  // 取该会话已有发言作为跨轮记忆起点(首轮为空)
  const priorMessages = sessions.getMessages(sessionId);

  // 把本轮用户输入也记进历史(agent_name=user),复刻 CLI 的做法
  const userTurn: AgentResponse = {
    agent_name: "user",
    role: "用户",
    message: requirement,
    next_agent: ARCHITECT,
    done: false,
    used_rag: false,
  };
  const seedMessages = [...priorMessages, userTurn];

  const initialState: AgentState = {
    requirement,
    messages: seedMessages,
    next_agent: null,
    done: false,
    iteration: 0,
  };

  let finalState: AgentState = initialState;
  try {
    const stream = await graph.stream(initialState, {
      recursionLimit: 50,
      streamMode: ["custom", "values"],
    });

    for await (const item of stream) {
      const [mode, chunk] = item as [string, unknown];
      if (mode === "custom") {
        const event = chunk as NodeStreamChunk;
        sse.send(sessionId, event.kind, event);
      } else {
        finalState = chunk as AgentState;
      }
    }

    const finalMessages = finalState.messages ?? seedMessages;
    sessions.replaceMessages(sessionId, finalMessages);
    sse.send(sessionId, "round_done", { done: finalState.done ?? false });
  } catch (exc) {
    logger.error(`[runDiscussion] 会话 ${sessionId} 出错: ${String(exc)}`);
    sse.send(sessionId, "error", { message: String(exc) });
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @meetmind/runtime test runDiscussion`
Expected: 2 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/server/runDiscussion.ts apps/runtime/src/server/runDiscussion.test.ts
git commit -m "feat: runDiscussion 把 graph 流转发成 SSE"
```

---

## Task 9: JSON-RPC 分发 rpc.ts（TDD）

**Files:**
- Create: `apps/runtime/src/server/rpc.ts`
- Test: `apps/runtime/src/server/rpc.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/runtime/src/server/rpc.test.ts`：
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleRpc } from "./rpc.js";
import * as sessions from "./sessions.js";
import type { buildGraph } from "../graph/builder.js";

// 假 graph:stream 立即结束,不产生任何事件
const fakeGraph = {
  async stream() {
    async function* gen() {
      yield ["values", { messages: [], done: true }];
    }
    return gen();
  },
} as unknown as ReturnType<typeof buildGraph>;

describe("handleRpc", () => {
  beforeEach(() => {
    sessions.resetSession("s1");
    sessions.setBusy("s1", false);
  });

  it("chat.send 立即返回 ok 并置 busy", async () => {
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 1,
      method: "chat.send",
      params: { sessionId: "s1", requirement: "做个登录页" },
    });
    expect(res).toMatchObject({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("缺参数返回 -32602", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 2,
      method: "chat.send",
      params: { sessionId: "s1" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("busy 会话再发返回 -32000", async () => {
    sessions.setBusy("s1", true);
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 3,
      method: "chat.send",
      params: { sessionId: "s1", requirement: "x" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32000);
  });

  it("session.reset 清空记忆", async () => {
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 4,
      method: "session.reset",
      params: { sessionId: "s1" },
    });
    expect(res).toMatchObject({ result: { ok: true } });
  });

  it("未知方法返回 -32601", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 5,
      method: "nope",
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32601);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @meetmind/runtime test rpc`
Expected: FAIL（找不到 `./rpc.js`）。

- [ ] **Step 3: 写实现**

`apps/runtime/src/server/rpc.ts`：
```ts
/**
 * JSON-RPC 2.0 分发。chat.send 触发一轮讨论(后台跑,立即返回,输出走 SSE);session.reset 清记忆。
 */
import type { buildGraph } from "../graph/builder.js";
import { runDiscussion } from "./runDiscussion.js";
import * as sessions from "./sessions.js";

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type CompiledGraph = ReturnType<typeof buildGraph>;
type RpcId = string | number | null;

/** 构造 JSON-RPC 错误响应。 */
function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/** 构造 JSON-RPC 成功响应。 */
function rpcOk(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export async function handleRpc(graph: CompiledGraph, body: RpcRequest) {
  const id: RpcId = body.id ?? null;
  const params = body.params ?? {};

  if (body.method === "chat.send") {
    const sessionId = params.sessionId;
    const requirement = params.requirement;
    if (typeof sessionId !== "string" || typeof requirement !== "string" || !sessionId || !requirement) {
      return rpcError(id, -32602, "缺少 sessionId 或 requirement");
    }
    if (sessions.isBusy(sessionId)) {
      return rpcError(id, -32000, "上一轮讨论还在进行");
    }
    sessions.setBusy(sessionId, true);
    // 后台跑,不 await:HTTP 立即返回,真正的输出全走 SSE;跑完(成功或失败)都清 busy
    const running = runDiscussion(graph, sessionId, requirement);
    running.finally(() => {
      sessions.setBusy(sessionId, false);
    });
    return rpcOk(id, { ok: true });
  }

  if (body.method === "session.reset") {
    const sessionId = params.sessionId;
    if (typeof sessionId === "string" && sessionId) {
      sessions.resetSession(sessionId);
    }
    return rpcOk(id, { ok: true });
  }

  return rpcError(id, -32601, `未知方法: ${body.method}`);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @meetmind/runtime test rpc`
Expected: 5 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/server/rpc.ts apps/runtime/src/server/rpc.test.ts
git commit -m "feat: JSON-RPC 分发 rpc"
```

---

## Task 10: HTTP 服务 httpServer.ts（node 内置 http）

**Files:**
- Create: `apps/runtime/src/server/httpServer.ts`

- [ ] **Step 1: 写实现（/api + /events + CORS，用 node:http）**

`apps/runtime/src/server/httpServer.ts`：
```ts
/**
 * Node 内置 http 服务(不引 express):
 *   POST /api      —— JSON-RPC 2.0
 *   GET  /events   —— SSE 长连(?sessionId=...)
 *   CORS 放行 localhost:5173 与 tauri 来源,OPTIONS 预检直接 204。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { buildGraph } from "../graph/builder.js";
import { handleRpc, type RpcRequest } from "./rpc.js";
import { addClient, removeClient } from "./sse.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.http");
type CompiledGraph = ReturnType<typeof buildGraph>;

/** 给响应加 CORS 头。开发期 Vite 代理已同源,这里主要为 Tauri 打包态。 */
function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** 读取整个请求体为字符串。 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 处理 POST /api。 */
async function handleApi(graph: CompiledGraph, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: RpcRequest;
  try {
    body = JSON.parse(raw) as RpcRequest;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } }));
    return;
  }
  const result = await handleRpc(graph, body);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

/** 处理 GET /events:开 SSE 长连并登记到 sessionId。 */
function handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    res.writeHead(400);
    res.end("missing sessionId");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // 先发一个注释帧,促使代理立即 flush 头
  res.write(": connected\n\n");
  addClient(sessionId, res);
  req.on("close", () => {
    removeClient(sessionId, res);
  });
}

/** 起服务并监听端口。 */
export function startServer(graph: CompiledGraph, port: number): void {
  const server = createServer((req, res) => {
    setCors(res);
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === "POST" && url.pathname === "/api") {
      handleApi(graph, req, res).catch((exc) => {
        logger.error(`/api 处理失败: ${String(exc)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(exc) } }));
      });
      return;
    }
    if (method === "GET" && url.pathname === "/events") {
      handleEvents(req, res, url);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  server.listen(port, () => {
    logger.info(`MeetMind runtime 服务已启动: http://localhost:${port}  (POST /api, GET /events)`);
  });
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @meetmind/runtime typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/runtime/src/server/httpServer.ts
git commit -m "feat: node http 服务(/api /events + CORS)"
```

---

## Task 11: 抽出 bootstrap + 改 index.ts 起服务

**Files:**
- Create: `apps/runtime/src/bootstrap.ts`
- Modify: `apps/runtime/src/cli/main.ts`（删除本地 bootstrap，改 import）
- Modify: `apps/runtime/src/index.ts`（起服务而非 CLI）

- [ ] **Step 1: 新建 bootstrap.ts，把 main.ts 的 bootstrap 函数原样搬来**

`apps/runtime/src/bootstrap.ts`：
```ts
/**
 * 启动自检 + 灌库:PostgreSQL 健康检查(失败 exit 1) → rerank 信息 → LangSmith 状态 →
 * 扫描种子目录 → 预热 embedding → 灌库。CLI 与 HTTP 服务共用。
 */
import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import chalk from "chalk";
import ora from "ora";

import { AGENT_NAMES } from "./config/constants.js";
import { getSettings } from "./config/settings.js";
import { countDocs, pingDb } from "./database/client.js";
import { getEmbedderModel } from "./database/embedding.js";
import { buildAgentsIndices } from "./database/initializer.js";
import { pathExists, printSystem } from "./utils/utils.js";
import { setupLogging } from "./utils/logger.js";

export async function bootstrap(): Promise<void> {
  setupLogging();
  const settings = getSettings();

  console.log("=".repeat(40), "get_settings() 拿到配置", "=".repeat(40));
  for (const [k, v] of Object.entries(settings)) {
    let display: string;
    if (typeof v === "string" && v.length > 0 && /key|token/i.test(k)) {
      display = `${v.slice(0, 4)}***${v.slice(-2)}`;
    } else {
      display = String(v);
    }
    console.log(`配置项 ${k}=${display}`);
  }
  console.log("=".repeat(100));
  console.log();

  // ---------- PostgreSQL 健康检查 ----------
  const safePgUrl = settings.pgUrl.replace(/\/\/[^@/]*@/, "//***@");
  printSystem(`PostgreSQL 地址: ${chalk.cyan(safePgUrl)}`);
  const pgOk = await pingDb();
  if (!pgOk) {
    printSystem(
      chalk.bold.red("✗ 无法连接到 PostgreSQL") +
        "\n请先在项目根目录执行 " +
        chalk.bold("docker compose up -d") +
        " 启动本地 PostgreSQL（含 pgvector），或修改 .env 中的 PG_URL 指向已有实例。",
    );
    process.exit(1);
  }
  printSystem(chalk.green("✓ PostgreSQL 已就绪"));

  // ---------- 本地 Rerank ----------
  printSystem(
    `本地 Rerank: ${chalk.cyan(settings.rerankModelName)}  ` +
      `(混合检索捞 ${chalk.bold(String(settings.retrieveTopN))} → rerank 取 ${chalk.bold(String(settings.rerankTopN))})`,
  );

  // ---------- LangSmith 追踪 ----------
  const langsmithOn = (process.env.LANGSMITH_TRACING ?? "").toLowerCase() === "true";
  if (langsmithOn) {
    const project = process.env.LANGSMITH_PROJECT ?? "default";
    printSystem(
      `LangSmith 追踪: ${chalk.bold.green("已启用")}  项目: ${chalk.cyan(project)}  ` +
        `→ https://smith.langchain.com/projects/p/${project}`,
    );
  } else {
    printSystem("LangSmith 追踪: " + chalk.dim("未启用（在 .env 中设置 LANGSMITH_TRACING=true 可开启）"));
  }

  // ---------- 扫描种子目录 ----------
  printSystem("扫描各 Agent 的 seed 文件目录：");
  for (const agent of AGENT_NAMES) {
    const dir = path.join(settings.seedDataPath, agent);
    if (!(await pathExists(dir))) {
      printSystem(`   · ${chalk.yellow(agent)}: (目录不存在，将走旧 *_seeds.json 兜底)`);
      continue;
    }
    const entries = await readdir(dir);
    const fileNames: string[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) {
        continue;
      }
      const s = await stat(path.join(dir, name));
      if (s.isFile()) {
        fileNames.push(name);
      }
    }
    fileNames.sort();
    if (fileNames.length === 0) {
      printSystem(`   · ${chalk.yellow(agent)}: 目录为空`);
    } else {
      printSystem(`   · ${chalk.cyan(agent)}: ${fileNames.length} 个文件 → ${fileNames.join(", ")}`);
    }
  }
  console.log();

  // ---------- 预热 embedding ----------
  const spinner1 = ora({ text: chalk.bold.cyan("预热 embedding 模型 (~80MB)..."), spinner: "dots" }).start();
  try {
    await getEmbedderModel();
    spinner1.succeed(chalk.green("✓") + " embedding 模型已加载到内存");
  } catch (exc) {
    spinner1.fail("embedding 加载失败");
    throw exc;
  }

  // ---------- 灌库 ----------
  const spinner2 = ora({ text: chalk.bold.cyan("初始化 5 个 Agent 的 PostgreSQL 表..."), spinner: "dots" }).start();
  let added: Record<string, number>;
  try {
    added = await buildAgentsIndices();
    spinner2.succeed("PostgreSQL 表初始化完成");
  } catch (exc) {
    spinner2.fail("PostgreSQL 表初始化失败");
    throw exc;
  }

  for (const agent of AGENT_NAMES) {
    const newCount = added[agent] ?? 0;
    const total = await countDocs(agent);
    const status = newCount > 0 ? `新增 ${chalk.bold.green(String(newCount))} 条，` : chalk.dim("无新增，");
    printSystem(`  ✓ ${chalk.bold(agent)}: ${status}表现共 ${total} 条文档`);
  }
}
```

- [ ] **Step 2: 删 main.ts 里的本地 bootstrap，改成 import**

在 `apps/runtime/src/cli/main.ts`：
1. 删除文件内整段本地 `async function bootstrap(): Promise<void> { ... }`（原第 56-169 行）。
2. 顶部 import 区加：
```ts
import { bootstrap } from "../bootstrap.js";
```
3. main.ts 里不再需要的、仅 bootstrap 用到的 import（`readdir`/`stat`、`countDocs`/`pingDb`、`getEmbedderModel`、`buildAgentsIndices`、`ora`、`pathExists`、`setupLogging`、`AGENT_NAMES`、`getSettings`）若 main 其余部分不再用到则删掉。保留 main 仍用到的（如 `chalk`、`printBanner`、`ROLE_DESCRIPTIONS`、`ARCHITECT`、`AgentResponse`、`buildGraph`、`AgentState`、`formatSeparator`/`printMessagesTable`/`printSystem`、`getLogger`、`createInterface`、`path`）。

> 验证手段是 Step 4 的 typecheck —— TS 会报出未使用/缺失的 import，按提示增删即可。

- [ ] **Step 3: 改 index.ts 起服务**

`apps/runtime/src/index.ts` 整体替换为：
```ts
/**
 * 进程入口(HTTP/SSE 服务)。
 * 顺序:dotenv → 动态 import(让 SDK 在 import 期读到 env) → bootstrap 自检灌库 → 编译图 → 起服务。
 * (CLI 仍可用 `pnpm --filter @meetmind/runtime dev:cli` 单独跑 src/cli/main.ts。)
 */
import { config } from "dotenv";

config();

const { bootstrap } = await import("./bootstrap.js");
const { buildGraph } = await import("./graph/builder.js");
const { startServer } = await import("./server/httpServer.js");

await bootstrap();
const graph = buildGraph();
startServer(graph, 3002);
```

- [ ] **Step 4: typecheck + 测试**

Run: `pnpm --filter @meetmind/runtime typecheck && pnpm --filter @meetmind/runtime test`
Expected: typecheck 0 错；所有测试 passed。

- [ ] **Step 5: 手动起服务冒烟（需 docker PostgreSQL 在跑）**

Run（终端 A）: `docker compose up -d && pnpm --filter @meetmind/runtime dev`
Expected: 走完 bootstrap，最后打印 `MeetMind runtime 服务已启动: http://localhost:3002`。

Run（终端 B）:
```bash
curl -N "http://localhost:3002/events?sessionId=test" &
sleep 1
curl -s -X POST http://localhost:3002/api -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"chat.send","params":{"sessionId":"test","requirement":"你好"}}'
```
Expected: POST 立即返回 `{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`；终端 A 的 SSE 流随后陆续出现 `event: turn_start`、若干 `event: delta`、`event: turn_end`、`event: round_done`。验证完 Ctrl+C 停掉。

- [ ] **Step 6: Commit**

```bash
git add apps/runtime/src/bootstrap.ts apps/runtime/src/cli/main.ts apps/runtime/src/index.ts
git commit -m "feat: 抽出 bootstrap, index.ts 改为起 HTTP/SSE 服务"
```

---

## Task 12: desktop 脚手架（Vue3 + Vite + Pinia）

**Files:**
- Create: `apps/desktop/package.json`、`apps/desktop/tsconfig.json`、`apps/desktop/vite.config.ts`、`apps/desktop/index.html`、`apps/desktop/src/main.ts`、`apps/desktop/src/App.vue`

- [ ] **Step 1: 写 `apps/desktop/package.json`**

```json
{
  "name": "@meetmind/desktop",
  "version": "0.2.0",
  "description": "MeetMind 桌面前端 (Tauri2 + Vue3)",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "vue-tsc --noEmit",
    "tauri": "tauri"
  },
  "dependencies": {
    "pinia": "^2.2.0",
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "@vitejs/plugin-vue": "^5.1.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vue-tsc": "^2.1.0"
  }
}
```

- [ ] **Step 2: 写 `apps/desktop/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "jsx": "preserve",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.vue"]
}
```

- [ ] **Step 3: 写 `apps/desktop/vite.config.ts`（5173 + 代理到 3002）**

```ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// /api 与 /events 代理到 runtime(3002)。SSE 经 http-proxy 流式透传,无需额外配置。
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:3002", changeOrigin: true },
      "/events": { target: "http://localhost:3002", changeOrigin: true },
    },
  },
});
```

- [ ] **Step 4: 写 `apps/desktop/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MeetMind</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: 写 `apps/desktop/src/main.ts`**

```ts
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";

const app = createApp(App);
app.use(createPinia());
app.mount("#app");
```

- [ ] **Step 6: 写占位 `apps/desktop/src/App.vue`（后续 Task 14 填真内容）**

```vue
<script setup lang="ts"></script>

<template>
  <div>MeetMind desktop 占位</div>
</template>
```

- [ ] **Step 7: 安装依赖并起 dev 验证脚手架**

Run: `pnpm install && pnpm --filter @meetmind/desktop dev`
Expected: Vite 在 `http://localhost:5173` 起来；浏览器打开能看到「MeetMind desktop 占位」。Ctrl+C 停。

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/package.json apps/desktop/tsconfig.json apps/desktop/vite.config.ts apps/desktop/index.html apps/desktop/src/main.ts apps/desktop/src/App.vue
git commit -m "feat: desktop 脚手架(Vue3+Vite+Pinia)"
```

---

## Task 13: 前端 API 层（rpcClient + sseClient）

**Files:**
- Create: `apps/desktop/src/api/rpcClient.ts`、`apps/desktop/src/api/sseClient.ts`

- [ ] **Step 1: 写 `rpcClient.ts`**

```ts
/** 极简 JSON-RPC 2.0 客户端:POST /api(经 Vite 代理到 3002)。 */
let nextId = 1;

export async function rpc<T = unknown>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const id = nextId++;
  const res = await fetch("/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(String(data.error.message ?? "RPC 出错"));
  }
  return data.result as T;
}
```

- [ ] **Step 2: 写 `sseClient.ts`（事件 payload 类型与 runtime 对齐）**

```ts
/** 连 /events 的 SSE,把各事件交给 handlers。事件结构与 runtime 的 NodeStreamChunk + round_done/error 对齐。 */
export interface TurnStartPayload { turnId: string; agent_name: string; role: string }
export interface DeltaPayload { turnId: string; text: string }
export interface TurnEndPayload { turnId: string; next_agent: string | null; done: boolean; used_rag: boolean }
export interface RoundDonePayload { done: boolean }
export interface ErrorPayload { message: string; turnId?: string }

export interface SseHandlers {
  onTurnStart: (p: TurnStartPayload) => void;
  onDelta: (p: DeltaPayload) => void;
  onTurnEnd: (p: TurnEndPayload) => void;
  onRoundDone: (p: RoundDonePayload) => void;
  onError: (p: ErrorPayload) => void;
}

export function openEvents(sessionId: string, handlers: SseHandlers): EventSource {
  const url = `/events?sessionId=${encodeURIComponent(sessionId)}`;
  const es = new EventSource(url);

  es.addEventListener("turn_start", (e) => {
    handlers.onTurnStart(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("delta", (e) => {
    handlers.onDelta(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("turn_end", (e) => {
    handlers.onTurnEnd(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("round_done", (e) => {
    handlers.onRoundDone(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("error", (e) => {
    const me = e as MessageEvent;
    // 网络层断线 EventSource 也会触发 error 但无 data;只处理服务端业务 error
    if (me.data) {
      handlers.onError(JSON.parse(me.data));
    }
  });

  return es;
}
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @meetmind/desktop typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/api/rpcClient.ts apps/desktop/src/api/sseClient.ts
git commit -m "feat: 前端 API 层 rpcClient + sseClient"
```

---

## Task 14: Pinia 状态 + UI 组件

**Files:**
- Create: `apps/desktop/src/theme/agentColors.ts`
- Create: `apps/desktop/src/stores/sessions.ts`、`apps/desktop/src/stores/chat.ts`
- Create: `apps/desktop/src/components/{MessageBubble,SessionList,ChatWindow,Composer}.vue`
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: agent 配色**

`apps/desktop/src/theme/agentColors.ts`：
```ts
/** agent_name → 气泡配色(背景/文字)。user 灰,5 个角色各异。 */
export interface AgentColor { bg: string; fg: string; label: string }

const COLORS: Record<string, AgentColor> = {
  user: { bg: "#e5e7eb", fg: "#111827", label: "用户" },
  architect: { bg: "#ede9fe", fg: "#5b21b6", label: "架构师" },
  backend: { bg: "#dbeafe", fg: "#1e40af", label: "后端" },
  frontend: { bg: "#dcfce7", fg: "#166534", label: "前端" },
  tester: { bg: "#ffedd5", fg: "#9a3412", label: "测试" },
  pm: { bg: "#fce7f3", fg: "#9d174d", label: "产品经理" },
};

const FALLBACK: AgentColor = { bg: "#f3f4f6", fg: "#374151", label: "未知" };

export function agentColor(agentName: string): AgentColor {
  return COLORS[agentName] ?? FALLBACK;
}
```

- [ ] **Step 2: sessions store**

`apps/desktop/src/stores/sessions.ts`：
```ts
import { defineStore } from "pinia";

export interface SessionMeta { id: string; title: string }

export const useSessionsStore = defineStore("sessions", {
  state: () => ({
    list: [] as SessionMeta[],
    activeId: "" as string,
  }),
  actions: {
    newSession(): string {
      const id = crypto.randomUUID();
      const title = `会话 ${this.list.length + 1}`;
      this.list.unshift({ id, title });
      this.activeId = id;
      return id;
    },
    select(id: string): void {
      this.activeId = id;
    },
  },
});
```

- [ ] **Step 3: chat store（每会话的气泡 + 流式状态）**

`apps/desktop/src/stores/chat.ts`：
```ts
import { defineStore } from "pinia";

export interface Bubble {
  turnId: string;        // user 气泡用 "user-<n>"
  agent_name: string;    // "user" 或 5 个角色名
  role: string;
  text: string;
  isUser: boolean;
  done: boolean;
  used_rag: boolean;
}

interface ChatState {
  bubblesBySession: Record<string, Bubble[]>;
  busyBySession: Record<string, boolean>;
}

export const useChatStore = defineStore("chat", {
  state: (): ChatState => ({
    bubblesBySession: {},
    busyBySession: {},
  }),
  getters: {
    bubblesOf: (state) => (sessionId: string) => state.bubblesBySession[sessionId] ?? [],
    isBusy: (state) => (sessionId: string) => state.busyBySession[sessionId] ?? false,
  },
  actions: {
    ensure(sessionId: string): void {
      if (!this.bubblesBySession[sessionId]) {
        this.bubblesBySession[sessionId] = [];
      }
    },
    addUser(sessionId: string, text: string): void {
      this.ensure(sessionId);
      const n = this.bubblesBySession[sessionId].length;
      this.bubblesBySession[sessionId].push({
        turnId: `user-${n}`,
        agent_name: "user",
        role: "用户",
        text,
        isUser: true,
        done: false,
        used_rag: false,
      });
      this.busyBySession[sessionId] = true;
    },
    startTurn(sessionId: string, turnId: string, agentName: string, role: string): void {
      this.ensure(sessionId);
      this.bubblesBySession[sessionId].push({
        turnId,
        agent_name: agentName,
        role,
        text: "",
        isUser: false,
        done: false,
        used_rag: false,
      });
    },
    appendDelta(sessionId: string, turnId: string, text: string): void {
      const bubbles = this.bubblesBySession[sessionId] ?? [];
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i].turnId === turnId) {
          bubbles[i].text += text;
          return;
        }
      }
    },
    endTurn(sessionId: string, turnId: string, usedRag: boolean): void {
      const bubbles = this.bubblesBySession[sessionId] ?? [];
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i].turnId === turnId) {
          bubbles[i].used_rag = usedRag;
          return;
        }
      }
    },
    finishRound(sessionId: string): void {
      this.busyBySession[sessionId] = false;
    },
    addErrorBubble(sessionId: string, message: string): void {
      this.ensure(sessionId);
      this.bubblesBySession[sessionId].push({
        turnId: `error-${this.bubblesBySession[sessionId].length}`,
        agent_name: "architect",
        role: "系统",
        text: `⚠️ ${message}`,
        isUser: false,
        done: false,
        used_rag: false,
      });
      this.busyBySession[sessionId] = false;
    },
  },
});
```

- [ ] **Step 4: MessageBubble.vue**

`apps/desktop/src/components/MessageBubble.vue`：
```vue
<script setup lang="ts">
import { computed } from "vue";
import type { Bubble } from "../stores/chat.js";
import { agentColor } from "../theme/agentColors.js";

const props = defineProps<{ bubble: Bubble }>();
const color = computed(() => agentColor(props.bubble.agent_name));
</script>

<template>
  <div class="row" :class="{ mine: bubble.isUser }">
    <div class="bubble" :style="{ background: color.bg, color: color.fg }">
      <div class="head">
        <span class="role">{{ bubble.role || color.label }}</span>
        <span v-if="bubble.used_rag" class="rag">RAG</span>
      </div>
      <div class="text">{{ bubble.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; margin: 8px 0; }
.row.mine { justify-content: flex-end; }
.bubble { max-width: 72%; padding: 10px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
.head { display: flex; gap: 8px; align-items: center; font-size: 12px; opacity: 0.85; margin-bottom: 4px; }
.role { font-weight: 600; }
.rag { font-size: 10px; border: 1px solid currentColor; border-radius: 6px; padding: 0 4px; }
.text { font-size: 14px; line-height: 1.5; }
</style>
```

- [ ] **Step 5: SessionList.vue**

`apps/desktop/src/components/SessionList.vue`：
```vue
<script setup lang="ts">
import { useSessionsStore } from "../stores/sessions.js";

const sessions = useSessionsStore();
</script>

<template>
  <aside class="sidebar">
    <button class="new" @click="sessions.newSession()">+ 新会话</button>
    <ul class="list">
      <li
        v-for="s in sessions.list"
        :key="s.id"
        :class="{ active: s.id === sessions.activeId }"
        @click="sessions.select(s.id)"
      >
        {{ s.title }}
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.sidebar { width: 220px; background: #1f2937; color: #e5e7eb; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; }
.new { background: #374151; color: #e5e7eb; border: none; border-radius: 8px; padding: 8px; cursor: pointer; margin-bottom: 12px; }
.new:hover { background: #4b5563; }
.list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
.list li { padding: 8px; border-radius: 8px; cursor: pointer; font-size: 14px; }
.list li.active, .list li:hover { background: #374151; }
</style>
```

- [ ] **Step 6: Composer.vue**

`apps/desktop/src/components/Composer.vue`：
```vue
<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ send: [text: string] }>();
const text = ref("");

function submit(): void {
  const value = text.value.trim();
  if (!value || props.disabled) {
    return;
  }
  emit("send", value);
  text.value = "";
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="composer">
    <textarea
      v-model="text"
      :disabled="disabled"
      placeholder="输入项目需求… (Enter 发送, Shift+Enter 换行)"
      @keydown="onKeydown"
    ></textarea>
    <button :disabled="disabled" @click="submit">发送</button>
  </div>
</template>

<style scoped>
.composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e5e7eb; }
textarea { flex: 1; resize: none; height: 56px; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; font-family: inherit; }
button { padding: 0 18px; background: #4f46e5; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
button:disabled { background: #a5b4fc; cursor: not-allowed; }
</style>
```

- [ ] **Step 7: ChatWindow.vue（连 SSE、发送、渲染气泡）**

`apps/desktop/src/components/ChatWindow.vue`：
```vue
<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useChatStore } from "../stores/chat.js";
import { rpc } from "../api/rpcClient.js";
import { openEvents } from "../api/sseClient.js";
import MessageBubble from "./MessageBubble.vue";
import Composer from "./Composer.vue";

const props = defineProps<{ sessionId: string }>();
const chat = useChatStore();

const bubbles = computed(() => chat.bubblesOf(props.sessionId));
const busy = computed(() => chat.isBusy(props.sessionId));
const scroller = ref<HTMLElement | null>(null);

// 每个 session 一条 SSE 连接,切换 sessionId 时重连
let es: EventSource | null = null;
function connect(sessionId: string): void {
  if (es) {
    es.close();
    es = null;
  }
  if (!sessionId) {
    return;
  }
  es = openEvents(sessionId, {
    onTurnStart: (p) => chat.startTurn(sessionId, p.turnId, p.agent_name, p.role),
    onDelta: (p) => chat.appendDelta(sessionId, p.turnId, p.text),
    onTurnEnd: (p) => chat.endTurn(sessionId, p.turnId, p.used_rag),
    onRoundDone: () => chat.finishRound(sessionId),
    onError: (p) => chat.addErrorBubble(sessionId, p.message),
  });
}

watch(
  () => props.sessionId,
  (id) => {
    chat.ensure(id);
    connect(id);
  },
  { immediate: true },
);

watch(
  () => bubbles.value.map((b) => b.text).join("|"),
  async () => {
    await nextTick();
    const el = scroller.value;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  },
);

async function onSend(text: string): Promise<void> {
  chat.addUser(props.sessionId, text);
  try {
    await rpc("chat.send", { sessionId: props.sessionId, requirement: text });
  } catch (e) {
    chat.addErrorBubble(props.sessionId, String(e));
  }
}
</script>

<template>
  <section class="chat">
    <div ref="scroller" class="scroll">
      <MessageBubble v-for="b in bubbles" :key="b.turnId" :bubble="b" />
    </div>
    <Composer :disabled="busy" @send="onSend" />
  </section>
</template>

<style scoped>
.chat { flex: 1; display: flex; flex-direction: column; height: 100vh; }
.scroll { flex: 1; overflow-y: auto; padding: 16px; background: #fff; }
</style>
```

- [ ] **Step 8: App.vue 组装左右两栏**

`apps/desktop/src/App.vue` 整体替换为：
```vue
<script setup lang="ts">
import { onMounted } from "vue";
import { useSessionsStore } from "./stores/sessions.js";
import SessionList from "./components/SessionList.vue";
import ChatWindow from "./components/ChatWindow.vue";

const sessions = useSessionsStore();

// 启动即建一个会话,避免空屏
onMounted(() => {
  if (sessions.list.length === 0) {
    sessions.newSession();
  }
});
</script>

<template>
  <div class="app">
    <SessionList />
    <ChatWindow v-if="sessions.activeId" :session-id="sessions.activeId" />
    <section v-else class="empty">点击「+ 新会话」开始</section>
  </div>
</template>

<style>
* { box-sizing: border-box; }
html, body, #app { margin: 0; height: 100%; }
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
.app { display: flex; height: 100vh; }
.empty { flex: 1; display: flex; align-items: center; justify-content: center; color: #9ca3af; }
</style>
```

- [ ] **Step 9: typecheck**

Run: `pnpm --filter @meetmind/desktop typecheck`
Expected: 无错误。

- [ ] **Step 10: 端到端手动验收（runtime + desktop 同时跑）**

Run（终端 A）: `docker compose up -d && pnpm --filter @meetmind/runtime dev`（等到「服务已启动」）
Run（终端 B）: `pnpm --filter @meetmind/desktop dev`，浏览器开 `http://localhost:5173`
操作并确认：
- 左栏自动有一个会话；点「+ 新会话」能再加。
- 右侧输入「做一个待办事项 App」回车 → 用户气泡右侧灰色出现；随后各 agent 气泡左侧按角色配色（架构师紫/后端蓝/…）出现，文字**逐段蹦出**（打字机）。
- 讨论进行中发送按钮禁用；`round_done` 后恢复可输入。
- 再发一句，确认 agent 能引用上一轮内容（跨轮记忆）。

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src
git commit -m "feat: 前端 Pinia 状态 + 会话列表/聊天窗/气泡/输入框"
```

---

## Task 15: Tauri 2 桌面外壳（需先装 Rust）

> 前置：用户已装 Rust 工具链（`rustup` → `rustc`/`cargo` 可用）。可用 `cargo --version` 确认。

**Files:**
- Create: `apps/desktop/src-tauri/*`（由 `tauri init` 生成）
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

- [ ] **Step 1: 确认 Rust 就绪**

Run: `cargo --version && rustc --version`
Expected: 都打印版本号。若 MISSING，先 `brew install rustup && rustup-init -y && source ~/.cargo/env`，再继续。

- [ ] **Step 2: 在 desktop 下初始化 Tauri**

Run: `pnpm --filter @meetmind/desktop exec tauri init`
交互回答：
- App name: `MeetMind`
- Window title: `MeetMind`
- Web assets 相对 `src-tauri` 的路径: `../dist`
- dev server URL: `http://localhost:5173`
- 前端 dev 命令: `pnpm dev`
- 前端 build 命令: `pnpm build`

- [ ] **Step 3: 核对 `apps/desktop/src-tauri/tauri.conf.json` 的 build 段**

确认（不对就改成）：
```json
{
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build"
  }
}
```

- [ ] **Step 4: 起 Tauri 桌面窗口验收（runtime 需另跑）**

Run（终端 A）: `docker compose up -d && pnpm --filter @meetmind/runtime dev`
Run（终端 B）: `pnpm --filter @meetmind/desktop tauri dev`
Expected: 弹出原生桌面窗口，行为与浏览器版一致（会话列表 + 聊天 + 打字机流式）。
（首次编译 Rust 依赖较慢，属正常。）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri apps/desktop/package.json
git commit -m "feat: Tauri 2 桌面外壳"
```

---

## Task 16: 根编排脚本 + 文档收尾

**Files:**
- Modify: `package.json`（根，加并行 dev）
- Modify: `README.md`（新增 monorepo 启动说明）

- [ ] **Step 1: 根 package.json 加并行 dev 脚本**

在根 `package.json` 的 `scripts` 里加一条（保留 Task 1 已有的其余脚本）：
```json
    "dev": "pnpm --parallel --filter \"./apps/*\" dev",
```
（`@meetmind/runtime` 的 `dev` 起服务、`@meetmind/desktop` 的 `dev` 起 Vite，二者并行。）

- [ ] **Step 2: README 增补启动说明段**

在 `README.md` 适当位置追加：
```markdown
## Monorepo 启动（runtime + desktop）

前置：`docker compose up -d` 起 PostgreSQL；首次 `pnpm install`。

- 同时起前后端：`pnpm dev`
- 只起后端服务（3002）：`pnpm dev:runtime`
- 只起前端（5173，浏览器联调）：`pnpm dev:desktop`
- 旧 CLI（保留，不再是默认入口）：`pnpm dev:cli`
- 桌面外壳（需先装 Rust）：`pnpm --filter @meetmind/desktop tauri dev`

后端 3002 暴露 `POST /api`（JSON-RPC：`chat.send` / `session.reset`）与 `GET /events?sessionId=…`（SSE：`turn_start`/`delta`/`turn_end`/`round_done`/`error`）。会话不持久化，前端刷新即清空。
```

- [ ] **Step 3: 全量验证**

Run: `pnpm install && pnpm typecheck && pnpm test`
Expected: 安装成功；两个 app typecheck 0 错；runtime 测试全 passed。

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "docs: monorepo 启动说明 + 根并行 dev 脚本"
```

---

## 自检（写完计划后对照 spec）

- **Spec 第 2 节 monorepo 布局** → Task 1（迁移 + PROJECT_ROOT 修复）✅
- **Spec 第 3 节 /api JSON-RPC + /events SSE 事件表** → Task 9（rpc）+ Task 10（http）+ Task 7（sse）✅
- **Spec 第 4 节 真·token 流式（onDelta + config.writer + 双模式 stream + 降级）** → Task 3/4/5/8 ✅
- **Spec 第 5 节 会话与跨轮记忆 + busy 串行** → Task 6（sessions）+ Task 8（seedMessages）+ Task 9（busy 拒重入）✅
- **Spec 第 6 节 UI（左会话列表 / 右聊天 / 角色配色 / Composer / Pinia / api 层）** → Task 12/13/14 ✅
- **Spec 第 7 节 端口/代理/Tauri/独立进程** → Task 12（vite proxy 5173→3002）+ Task 11（listen 3002）+ Task 15（Tauri）+ Task 16（编排）✅
- **Spec 第 8 节 错误处理（pingDb exit / turn 内出错发 error / SSE 断线清理 / 重入拒绝）** → Task 11（bootstrap exit）+ Task 8（catch→error）+ Task 10（req close→removeClient）+ Task 9（busy）✅
- **Spec 第 9 节 测试** → Task 2（vitest）+ Task 3/6/7/8/9（单测）+ 各 Task 手动验收 ✅
- **Spec 第 10 节 不做** → 计划未引入持久化/sidecar/鉴权 ✅

类型一致性核对：`AgentResponse` 六字段全程一致；`NodeStreamChunk` 的 kind（turn_start/delta/turn_end）== SSE 事件名 == 前端 `sseClient` 监听名；`streamStructuredContent` 签名在 Task 3 定义、Task 4 调用一致；`startServer(graph, port)`、`handleRpc(graph, body)`、`runDiscussion(graph, sessionId, requirement)` 签名前后一致。无占位符。
```
