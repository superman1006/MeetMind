# 测试指南 (Testing Guide)

MeetMind 的测试约定与测试计划。目标:核心逻辑有快速、可靠、可门禁的单元测试覆盖,作为合并前的质量基线。

## 技术栈

| 用途 | 工具 |
|---|---|
| 测试框架(两端) | [Vitest](https://vitest.dev) 2.1 |
| 前端 DOM 环境 | `happy-dom`(`apps/desktop`,提供 `document` 等;`localStorage` 见下方注意) |
| 覆盖率 | `@vitest/coverage-v8`(两端,带 **per-file 阈值门禁**) |
| 后端环境 | `node` |

## 怎么跑

```bash
pnpm test                 # 跑两端全部测试(pnpm -r test)
pnpm test:coverage        # 两端测试 + 覆盖率门槛(任一文件不达标即非零退出)

pnpm --filter @meetmind/runtime test            # 只跑后端
pnpm --filter @meetmind/desktop test            # 只跑前端
pnpm --filter @meetmind/runtime exec vitest      # watch 模式调试
```

覆盖率 HTML 报告输出在各包的 `coverage/index.html`。

## 测试金字塔与分层策略

```
        /  E2E  \        Playwright 手动实操(改动验收时跑,不进 CI 门禁)
       / 集成测试 \       rpc 总机 / runExecution(假 graph)/ meetingSummary
      /  单元测试   \      路由 / 工具函数 / 切块 / 数据层(mock pg)/ stores / api 客户端
```

- **单元测试(主力)**:纯函数、状态机、数据映射。快、稳、定位精确。
- **集成测试(少量)**:`rpc.handleRpc` 用假 graph + 打桩 chatStore;`runExecution` 用假 graph 流。
- **E2E(人工)**:`pnpm dev:runtime` + `pnpm dev:desktop`,浏览器(Playwright 连 5173)实操,见各 spec 的「验证」节。不纳入自动化门禁。

### 约定(重要)

- **数据层 mock pg**:`chatStore` / `client` 这类查库代码,用 `vi.mock("./client.js")` 提供假 `getPgPool`,只断言拼出的 SQL 片段与返回映射,**不连真库**(CI 不依赖 PostgreSQL)。
- **api 客户端 mock 传输层**:`rpcClient` 打桩 `fetch`;`sseClient` 用假 `EventSource` 类手动派发事件。
- **不测真实重 IO**:LLM 调用(`agents/base` 的 `invoke`)、embedding、rerank 等模型推理**不做单测**(慢、需外部依赖);只测其周边纯逻辑与降级分支。
- **house style**:测试代码同样避免数组方法链做数据管道,优先显式 `for` + 具名中间变量。
- **happy-dom + Node 25 的 localStorage 坑**:Node 25 自带的全局 `localStorage` 会盖过 happy-dom 且行为不一致。需要 `localStorage` 的测试用 `vi.stubGlobal("localStorage", 内存版)` 打桩(见 `stores/ui.test.ts`)。

## 覆盖率门禁

两端 `vitest.config.ts` 均开 `coverage.thresholds.perFile = true`:**被纳入 `coverage.include` 的每个文件**都必须满足

| 指标 | 阈值 |
|---|---|
| lines / statements / functions | ≥ 80% |
| branches | ≥ 70% |

`include` 只圈「已写测试的核心模块」;LLM / embedding / rerank / HTTP server / CLI / Vue 组件 / 入口文件等暂不纳入门禁(原因见上「不测真实重 IO」)。扩大覆盖时:写好测试 → 把文件加进对应 `vitest.config.ts` 的 `coverage.include` → 跑 `pnpm test:coverage` 确认达标。

当前实际覆盖(两端 include 集均 100% functions):
- runtime:lines 97.9% / branch 90.4%
- desktop:lines 98.4% / branch 86.6%

## 已覆盖模块

### Runtime(`apps/runtime`,157 例 / 23 文件)

| 模块 | 测了什么 |
|---|---|
| `graph/route` | `routeToWhichAgent` 四优先级(迭代上限 > done > 合法 next > 兜底架构师) |
| `graph/preprocess`(`intentNode` / `routePreprocess`) | 意图规则短路(问候→闲聊 / 开发关键词→开发需求)、`intent_margin` 计算、`route_node` 按间距分流 chat/team |
| `graph/checkpointer` | `PostgresSaver` 单例 + `deleteThreadCheckpoints`(mock pg) |
| `utils/utils` | `cleanBadChars`(孤立代理对清理)/ `formatSeparator` / `pathExists` / `colorize` / CLI 打印冒烟 |
| `config/constants` | `isAgentName` / `AGENT_NAMES` / `ROLE_DESCRIPTIONS` |
| `config/settings` | `getSettings` 单例与默认值 / `resolveRel` 路径锚定 / 模型热切换覆盖 |
| `agents/{coerceDone,streamStructured}` | `done` 强转真值表 / 流式结构化输出逐段吐字 |
| `database/connection/constants` | `getTableName` 表名拼装 |
| `database/ingestion/splitters` | `splitJson` 透传 / `splitText`·`splitMarkdown` 切块 / `splitDocs` 按类型分发与兜底 |
| `database/chat/chatStore` | 全部增删改查 + `seq` 递增 + `ended`/owner/压缩/在途 thread 持久化(mock pg) |
| `database/users/userStore` | 账号鉴权 + 个人记忆读写(mock pg) |
| `server/rpcServer` | JSON-RPC 总机各 method(chat.*/session.*/user.*/model.*/toolApproval,含 ended 守卫) |
| `server/toolApprovals` | HITL 审批挂起 Promise 的 createPending / resolve |
| `server/{sessions,sseServer,runExecution,meetingSummary,titleSummary}` | 已有 |
| `tools/{mcp/mcpClient,webFetchTool}` | MCP 适配 shim / web_fetch |

### Desktop(`apps/desktop`,75 例 / 9 文件)

| 模块 | 测了什么 |
|---|---|
| `stores/chat` | 气泡收发 / `useTool` 去重 / `finishRound` 弹空泡 / `load` / `markEnded`·`hydrateEnded` / `drop` |
| `stores/sessions` | `load`/`newSession`/`rename`/`remove`(mock rpc) |
| `stores/auth` | 登录 / 注册 / 登出 + 持久化(mock rpc) |
| `stores/ui` | 收缩切换 / 主题切换 + 持久化 + `data-theme` / `initTheme` |
| `api/rpcClient` | 成功返回 result / error 字段抛错 / id 递增(mock fetch) |
| `api/sseClient` | 各 SSE 事件转交 handler / `error` 仅带 data 才回调(假 EventSource) |
| `theme/agentColors` | 已知角色配色 / 未知兜底 |
| `utils/{markdown,sessionGroups}` | markdown 渲染 / 会话按时间分组 |

## 暂未覆盖 / 后续可加

- **Vue 组件渲染测试**(`Composer`/`SessionSearch`/`MessageBubble` 等):本轮按约定只测逻辑层,未引入 `@vue/test-utils`。要做组件交互测试时再加。
- **`agents/base.ts`**:`_buildAgentResponse`(done 强转 / next_agent 兜底)是私有方法且与 LLM 调用耦合,单测需重构抽出纯函数,暂缓。
- **`database/{loaders,embedding,reranker,rag_retriever,initializer}`**:文件 IO / 模型推理,适合做集成测试(连真库 + 真模型),不在当前单测门禁内。
- **真实 PostgreSQL 集成测试**:当前数据层走 mock pg;如需更贴近真实,可加一套连 `docker compose` 起的 PG 的集成套件(CI 需提供 PG 实例)。
