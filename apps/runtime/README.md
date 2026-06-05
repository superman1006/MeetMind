# @meetmind/runtime — 后端引擎 + HTTP/SSE 服务

MeetMind 的后端：5 个角色 Agent（架构师 / 后端 / 前端 / 测试 / 产品经理）在 **LangGraph** 条件边驱动下围绕一个需求展开讨论，每个 Agent 有独立的 **PostgreSQL（pgvector）私有知识库** + **混合检索 RAG 工具**，并可调用一批通用工具（命令行 / 文件 / 联网搜索）。对外开一个 `node:http` 服务：`POST /api`（JSON-RPC）下指令、`GET /events`（SSE）推讨论流。

> 这是 monorepo 里的后端包。全栈说明见仓库根 [`README.md`](../../README.md)；逐函数调用链见 [`project_flow.md`](../../project_flow.md)。前端见 [`apps/desktop`](../desktop/README.md)。

---

## 技术栈

- **TypeScript（ESM + NodeNext）**，用 `tsx` 直接跑 `.ts`，开发期不预编译。相对 import 一律带 `.js` 后缀。
- **LangChain + LangGraph**：Agent 编排、工具绑定、结构化输出。
- **LLM**：OpenAI 兼容协议（`@langchain/openai` 的 `ChatOpenAI`），默认面向小米 MiMo（`modelKwargs.thinking={type:"disabled"}` 关后端思考模式，**不能删**）。
- **PostgreSQL（pgvector）**：文档存储 + `pg_trgm` 关键字召回 + `pgvector` 向量 kNN 三合一，外加会话/消息持久化。
- **本地 ONNX 模型**（`@huggingface/transformers`）：embedding（`Xenova/all-MiniLM-L6-v2`，384 维）+ rerank（`Xenova/bge-reranker-base`，q8 量化 cross-encoder）。**无需联网 / 无 API key**。
- **MCP**：通过 `@langchain/mcp-adapters` 的 `MultiServerMCPClient` 接入外部 MCP 服务（默认百度 AI Search）。

---

## 运行

前置：仓库根 `docker compose up -d` 起 PostgreSQL（pgvector，宿主机 5433）；根目录 `pnpm install`；根 `.env` 填好 `API_KEY / BASE_URL / MODEL_NAME`。

```bash
# 在仓库根目录：
pnpm dev:runtime        # = pnpm --filter @meetmind/runtime dev → tsx src/index.ts，起 HTTP 服务(3002)
pnpm dev:cli            # 旧的交互式 CLI（非流式、无服务），保留可用

# 或在本目录 apps/runtime/：
pnpm dev                # tsx src/index.ts（HTTP 服务）
pnpm dev:cli            # tsx src/cli/main.ts（CLI）
pnpm build              # tsc 编译到 dist/
pnpm start:prod         # node dist/index.js
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run
```

> ⚠️ **runtime 用 `tsx` 启动、不 watch**：改了服务端代码（尤其 `server/rpc.ts` 新增 method、或工具/MCP）后必须**重启 runtime 进程**，否则前端调新 method 会收到「未知方法: xxx」。前端 vite 有 HMR 不用重启。

启动时（`bootstrap()`）：ping PostgreSQL（失败 `process.exit(1)`，唯一硬退出）→ 建会话/消息表 → 预热 embedding 模型（首次 ~80MB）→ 灌种子到各 agent 表（`ON CONFLICT` 幂等）→ 加载 MCP 工具（连得上才有，连不上只 log、不挂启动）。

---

## 调用链一句话

```
index.ts (load .env) → bootstrap() → buildGraph() → startServer(graph, 3002)
                                                          │
   POST /api ─ handleRpc ─ chat.send ─► runExecution(graph, …) ─ graph.stream(["custom","values"])
                                                          │
                       createNode(agent) 闭包 ─► agent.invoke()  ── writer ──► SSE 事件
                            （Phase1 工具循环 + Phase2 结构化收尾）
                                                          ▼
                                 routeToWhichAgent(state) → 下一个 _node 或 END
```

`BaseAgent.invoke()` **分两阶段**：
1. **Phase 1 工具循环**：复用构造阶段已 `bindTools(allTools)` 的模型，LLM 自主调工具，最多 3 轮。每次工具执行后把 `{name, args, result}` 收集进 `tool_calls`，并实时回调 `onToolResult`。
2. **Phase 2 结构化收尾**：`withStructuredOutput(ModelOutputSchema)` 强制产出 `{content, next_agent, done}`。

路由 `routeToWhichAgent`：`iteration ≥ maxIterations → END`；`done → END`；`next_agent ∈ AGENT_NAMES → 对应节点`；兜底回 architect。

---

## RAG 检索链路

```
query ──┬─► pg_trgm 关键字召回 (word_similarity)  ──┐
        │                                           ├─► 合并去重 ─► 本地 cross-encoder rerank ─► top_5 给 LLM
        └─► pgvector 向量 kNN (cosine <=>)         ──┘
```

两路**并行**召回各 `RETRIEVE_TOP_N=20` 条，按行 `id` 去重合并，全部送本地 cross-encoder rerank 取 `RERANK_TOP_N=5`。任一路 SQL 抛错只返回空、另一路独立工作；rerank 模型失败降级为原序返回前 N 条。

---

## 工具层 `src/tools/`

每个本地工具是一个 `<xxx>Tool.ts` 导出的 LangChain `tool()` 单例，集中在 [`toolRegister.ts`](src/tools/toolRegister.ts) 同步登记进 `allTools`；MCP 工具在 bootstrap 阶段**异步**追加进同一个数组。新增本地工具 = 新建一个文件 + 在 `toolRegister.ts` 加一行 import + 一行 `register`。

| 工具名 | 文件 | 作用 |
|---|---|---|
| `rag_search` | `ragSearchTool.ts` | 私有 RAG，按调用时 `config.configurable.agentName` 查对应 agent 的私有表 |
| `echo` | `echoTool.ts` | 命令行 `echo` 回显文本（`execFile`，不过 shell，无注入） |
| `list_processes` | `processTool.ts` | `ps aux` 看进程，可选 `filter` 关键字 |
| `list_dir` | `listDirTool.ts` | 列目录（`fs.readdir`，标注 dir/file） |
| `read_file` | `readFileTool.ts` | 读文件文本（`fs.readFile`，超 2 万字符截断） |
| `AIsearch` | `mcp/mcpClient.ts` | 联网搜索，经 `MultiServerMCPClient` 接入百度 AI Search MCP（上游原名 `AIsearch`） |

### MCP 接入 `src/tools/mcp/mcpClient.ts`

`initMcpTools()`（bootstrap 调，buildGraph 之前）用 `MultiServerMCPClient` 连百度 AI Search 的 SSE 端点，`getTools()` 发现工具后登记进 `toolRegister`。

> ⚠️ **版本兼容 shim**：锁定 `@langchain/mcp-adapters@1.1.3`（它能在本仓库 `zod@3.25` 下正常 import；0.x 版会在 import 期崩）。但 1.1.3 产出的工具 `.schema` 是 **JSON Schema**，而本仓库 `@langchain/openai@0.3.17` 的 `bindTools` 假定是 zod、会崩（`reading 'typeName'`）。所以 `mcpClient.ts` 里有个 `wrapMcpToolWithZod`：登记前把 MCP 工具的 JSON Schema 现造成等价 zod schema、再包一层委托执行的工具。改 MCP 相关代码时别动这层。

---

## 工具调用明细 `tool_calls`

每条 `AgentResponse` 带一个 `tool_calls?: ToolCallRecord[]`（`{name, args, result}` 数组），记录本轮每一次工具调用的入参与返回。它：

- 在 `base.ts` Phase 1 循环里收集；
- 通过 SSE `tool_result` 事件实时推给前端（每次调用一条）；
- 落库进 `messages.tool_calls`（jsonb 列），历史消息 reload 后仍可查看。

前端据此给每次调用渲染一个按钮，点开在气泡下方显示该次调用的结果（见 [`apps/desktop`](../desktop/README.md)）。

---

## HTTP / SSE 接口（端口 3002）

**`POST /api`（JSON-RPC）**：

| method | 作用 |
|---|---|
| `chat.send` | 开一轮讨论（后台跑、立即返回 `{ok:true}`，过程走 SSE） |
| `chat.interrupt` | 打断本轮（abort，丢弃不落库） |
| `chat.end` | 结束会议 → 后台整理会议纪要写 `data/summary/<id>.md` |
| `session.create` / `session.list` / `session.messages` / `session.rename` / `session.delete` | 会话 CRUD |

**`GET /events?sessionId=…`（SSE）**：

| 事件 | 何时 | 负载 |
|---|---|---|
| `turn_start` | 某 agent 开始发言 | `{ turnId, agent_name, role }` |
| `delta` | Phase 2 流式吐字 | `{ turnId, text }` |
| `using_tools` | 工具执行前 | `{ turnId, tool }` |
| `tool_result` | 工具执行后 | `{ turnId, name, args, result }` |
| `turn_end` | 某 agent 结束 | `{ turnId, next_agent, done, used_rag }` |
| `round_done` | 一轮结束 | `{ done }` / `{ done:false, interrupted:true }` |
| `error` | 讨论异常 | `{ message }` |
| `summary_done` / `summary_error` | 纪要完成 / 失败 | `{ file }` / `{ message }` |

会话与消息持久化在 PostgreSQL（`<prefix>_sessions` / `<prefix>_messages`）；运行时状态（busy + AbortController）在内存、重启即重置。

---

## 目录结构 `src/`

```text
src/
├── index.ts                # 进程入口：load .env → bootstrap → buildGraph → startServer(3002)
├── bootstrap.ts            # 启动自检 + 灌库 + 加载 MCP 工具
├── cli/main.ts             # 旧交互式 CLI（非流式，保留）
├── agents/
│   ├── base.ts             # BaseAgent 抽象类：两阶段 invoke + ToolCallRecord/AgentResponse + summarizeAll
│   ├── architect|backend|frontend|tester|pm.ts   # 5 个角色子类（只重写 systemPrompt）
│   └── streamStructured.ts # 流式结构化输出逐段吐 content
├── graph/
│   ├── builder.ts          # buildGraph / buildAllAgents / createNode 节点工厂
│   ├── route.ts            # routeToWhichAgent 条件边
│   ├── state.ts            # AgentStateAnnotation（Annotation.Root）
│   └── streamEvents.ts     # NodeStreamChunk（节点自定义流事件类型）
├── database/
│   ├── client.ts           # pg.Pool 单例 + 建表/扩展/索引
│   ├── embedding.ts        # 本地 ONNX embedding
│   ├── reranker.ts         # 本地 cross-encoder rerank（含降级）
│   ├── rag_retriever.ts    # 关键字 + 向量并行召回 → 去重 → rerank；getRetriever(name) 缓存
│   ├── initializer.ts      # buildAgentsTables / loadSeedsToPg / resetAgentDb（幂等灌库）
│   ├── loaders.ts          # JSON/MD/PDF/DOCX/TXT 五种 loader
│   ├── splitters.ts        # 按 type 切块
│   ├── chatStore.ts        # sessions / messages 持久化（含 tool_calls jsonb 列）
│   └── constants.ts        # 表名 <prefix>_<agent>
├── tools/
│   ├── toolRegister.ts     # ToolRegister 类 + 单例 + 本地工具登记 + allTools
│   ├── ragSearchTool.ts / echoTool.ts / processTool.ts / listDirTool.ts / readFileTool.ts
│   └── mcp/mcpClient.ts    # MultiServerMCPClient 接入 + JSON-Schema→zod shim
├── server/
│   ├── httpServer.ts       # POST /api + GET /events
│   ├── rpc.ts              # handleRpc 按 method 分诊
│   ├── runExecution.ts    # 跑一轮讨论，graph.stream → SSE，增量落库
│   ├── sse.ts              # SSE 长连登记表 + send()
│   ├── sessions.ts         # 会话运行时状态（busy + AbortController，内存）
│   └── meetingSummary.ts   # 会议结束整理
├── config/
│   ├── settings.ts         # zod Settings 单例（读 .env + 相对路径锚定 PROJECT_ROOT）
│   └── constants.ts        # AGENT_NAMES / 角色常量 / isAgentName
└── utils/                  # logger / utils（printAgentInfo / cleanBadChars 等）
```

> 种子文件在仓库根 `data/seed/<agent>/`，模型缓存在根 `models/`，`.env` 在根——两个 app 共享。`PROJECT_ROOT` 由 `config/settings.ts` 向上四级（config→src→runtime→apps）到仓库根。

---

## 开发常用

```bash
# 重置某个 agent 的表并重灌
pnpm exec tsx -e "import('./src/database/initializer.ts').then(m => m.resetAgentDb('backend'))"

# 完全抹库重灌（删 docker volume，下次启动重建）
docker compose down -v && docker compose up -d   # 在仓库根
```

环境变量见根 `.env.example`。检索参数 `RETRIEVE_TOP_N` / `RERANK_TOP_N`、MCP 端点 `BAIDU_SEARCH_MCP_URL` / `BAIDU_SEARCH_API_KEY` 都在 `.env`。
