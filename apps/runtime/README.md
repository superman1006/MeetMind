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

> ⚠️ **runtime 用 `tsx` 启动、不 watch**：改了服务端代码（尤其 `server/rpcServer.ts` 新增 method、或工具/MCP）后必须**重启 runtime 进程**，否则前端调新 method 会收到「未知方法: xxx」。前端 vite 有 HMR 不用重启。

启动时（`bootstrap()`）：ping PostgreSQL（失败 `process.exit(1)`，唯一硬退出）→ 建会话/消息表 → 预热 embedding 模型（首次 ~80MB）→ 灌种子到各 agent 表（`ON CONFLICT` 幂等）→ 加载 MCP 工具（连得上才有，连不上只 log、不挂启动）。

---

## 调用链一句话

```
index.ts (load .env) → bootstrap() → buildGraph() → startServer(graph, 3002)
                                                          │
   POST /api ─ handleRpc ─ chat.send ─► runExecution(graph, …) ─ graph.stream(["custom","values"])
                                                          │
   START → rewrite_node → intent_node → route_node ──┬─► assistant_node → END      （右侧回答助手）
                                                     └─► architect_node → … 团队   （左侧 5 角色协作）
                                                          │
                       createNode(agent) 闭包 ─► agent.invoke()  ── writer ──► SSE 事件
                            （Phase1 工具循环 + Phase2 结构化收尾）
                                                          ▼
                                 routeToWhichAgent(state) → 下一个 _node 或 END
```

**预处理流水线**（每轮入口跑一次，不计入 `iteration`）：`rewrite_node`（改写独立句 + 检索扩展词）→ `intent_node`（本地 NLI 意图识别 + 规则短路：问候→闲聊、开发关键词→开发需求）→ `route_node`（按 top-1/top-2 **间距** `INTENT_ROUTE_MARGIN` 分流：闲聊/知识问答→右侧助手，其余→左侧团队，判定不了默认走助手）。

`BaseAgent.invoke()` **分两阶段**：
1. **Phase 1 工具循环**：复用构造阶段已 `bindTools(allTools)` 的模型，LLM 自主调工具，最多 3 轮（实现在 `agents/toolLoop.ts`）。每次工具执行后把 `{name, args, result}` 收集进 `tool_calls`，并实时回调 `onToolResult`；`risk > low` 的工具执行前先发 `tool_approval_request` 等用户审批（HITL）；模型幻觉出的未知工具会被跳过、只回一条占位 ToolMessage。
2. **Phase 2 结构化收尾**：`withStructuredOutput(ModelOutputSchema)` 强制产出 `{content, next_agent, done}`。

> **右侧回答助手** `AssistantAgent.answer()`：复用同一套工具循环，但 Phase 2 改成纯自然语言流式收尾（不结构化、不填 `next_agent`），答完直接 → END，与左侧团队仅共享 `AgentState`、不碰 `iteration`。

路由 `routeToWhichAgent`：`iteration ≥ maxIterations → END`；`done → END`；`next_agent ∈ AGENT_NAMES → 对应节点`；兜底回 architect。

> **崩溃恢复**：图 `compile({ checkpointer: PostgresSaver })`，被打断的一轮留下 checkpoint；重开会话时 `chat.getResumable` 探测、`chat.resume` 续跑（`resumeExecution`）、`chat.discardResumable` 放弃并删 checkpoint。

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

每个工具带一个 `metadata.risk`（`low` / `medium` / `high`）：`> low` 的工具执行前会触发 HITL 审批（发 `tool_approval_request`，等 `toolApproval` 回执）。

| 工具名 | 文件 | risk | 作用 |
|---|---|---|---|
| `rag_search` | `ragSearchTool.ts` | low | 私有 RAG，按调用时 `config.configurable.agentName` 查对应 agent 的私有表（拼 `expansionTerms` 提召回） |
| `Read` | `readFileTool.ts` | low | 读文件文本（`fs.readFile`，超 2 万字符截断） |
| `list_dir` | `listDirTool.ts` | low | 列目录（`fs.readdir`，标注 dir/file） |
| `glob` | `globTool.ts` | low | 按 glob 模式匹配文件路径 |
| `grep` | `grepTool.ts` | low | 在文件内容里按正则搜索 |
| `echo` | `echoTool.ts` | low | 命令行 `echo` 回显文本（`execFile`，不过 shell，无注入） |
| `list_processes` | `processTool.ts` | low | `ps aux` 看进程，可选 `filter` 关键字 |
| `skill` | `skillTool.ts` | low | 列举 / 读取 `src/skills/<name>/SKILL.md` 技能说明 |
| `Edit` | `fileEditTool.ts` | **medium** | 对文件做精确字符串替换（落盘改文件） |
| `web_fetch` | `webFetchTool.ts` | **medium** | 抓取 URL 正文 |
| `Write` | `writeFileTool.ts` | **high** | 写 / 覆盖文件（副作用最强，默认必经审批） |
| `AIsearch` | `mcp/mcpClient.ts` | — | 联网搜索，经 `MultiServerMCPClient` 接入百度 AI Search MCP（上游原名 `AIsearch`） |

> 文件类工具（`Read` / `Edit` / `Write` / `glob` / `grep` / `list_dir`）经 `pathAuth.ts` 做路径授权与越界防护。

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

**`POST /api`（JSON-RPC，由 `server/rpcServer.ts` 的 `handleRpc` 分诊）**：

| method | 作用 |
|---|---|
| `chat.send` | 开一轮讨论（后台跑、立即返回 `{ok:true}`，过程走 SSE） |
| `chat.interrupt` | 打断本轮（abort，丢弃不落库） |
| `chat.summaryTitle` | 用新会话首条输入生成 ≤15 字标题（与 `chat.send` 并行、独立 LLM 调用） |
| `chat.compact` | 上下文压缩：把边界前历史滚动总结成摘要写进 `sessions`，此后喂 LLM 走「摘要 + 尾部」 |
| `chat.getResumable` / `chat.resume` / `chat.discardResumable` | 崩溃残留的未完成轮：探测可恢复 / 从 checkpoint 续跑 / 放弃并删 checkpoint |
| `chat.end` | 结束会议 → 后台整理会议纪要写 `data/summary/<id>.md` |
| `session.create` / `session.list` / `session.messages` / `session.rename` / `session.delete` | 会话 CRUD（`create` / `list` 按 `username` 隔离） |
| `user.login` / `user.registry` / `user.getMemory` / `user.setMemory` | 账号鉴权 + 个人记忆读写（记忆经 `memorySection` 注入各 agent system prompt） |
| `toolApproval` | HITL 工具审批回执，兑现后端挂起的审批 Promise（`server/toolApprovals.ts`） |
| `model.get` / `model.set` / `model.test` | 读 / 热切换 LLM 配置（`set` 会 `buildGraph()` 重建图）/ 探连通性 |

**`GET /events?sessionId=…`（SSE）**：

| 事件 | 何时 | 负载 |
|---|---|---|
| `turn_start` | 某 agent 开始发言 | `{ turnId, agent_name, role }` |
| `delta` | Phase 2 流式吐字 | `{ turnId, text }` |
| `using_tools` | 工具执行前 | `{ turnId, tool }` |
| `tool_approval_request` | 高风险工具执行前（HITL） | `{ turnId, approvalId, tool, risk, args }` |
| `tool_result` | 工具执行后 | `{ turnId, name, args, result }` |
| `turn_end` | 某 agent 结束 | `{ turnId, next_agent, done, used_rag }` |
| `round_done` | 一轮结束 | `{ done }` / `{ done:false, interrupted:true }` |
| `error` | 讨论异常 | `{ message }` |
| `summary_done` / `summary_error` | 纪要完成 / 失败 | `{ file }` / `{ message }` |

会话 / 消息 / 用户 / 个人记忆持久化在 PostgreSQL（`<prefix>_sessions` / `<prefix>_messages` / `<prefix>_users`），LangGraph checkpoint 在自管的 `checkpoint*` 表；运行时状态（busy + AbortController + 挂起的工具审批）在内存、重启即重置。

---

## 目录结构 `src/`

```text
src/
├── index.ts                # 进程入口：load .env → bootstrap → buildGraph → startServer(3002)
├── bootstrap.ts            # 启动自检 + 灌库 + 加载 MCP 工具
├── cli/main.ts             # 旧交互式 CLI（非流式，保留）
├── agents/
│   ├── base.ts             # BaseAgent 抽象类：两阶段 invoke + ToolCallRecord/AgentResponse + memorySection + summarizeAll
│   ├── toolLoop.ts         # Phase 1 工具循环（runToolLoop）：执行工具 / HITL 审批 / 跳过未知工具，base 与 assistant 共用
│   ├── assistant.ts        # AssistantAgent：右侧回答助手 answer()（工具循环 + 纯文本流式收尾，不结构化）
│   ├── architect|backend|frontend|tester|pm.ts   # 5 个角色子类（只重写 systemPrompt）
│   └── streamStructured.ts # 流式结构化输出逐段吐 content
├── graph/
│   ├── builder.ts          # buildGraph / buildAllAgents / createNode / createAssistantNode 节点工厂
│   ├── preprocess/
│   │   ├── rewriteNode.ts  # rewrite_node：改写独立句 + 检索扩展词（withStructuredOutput）
│   │   ├── intentNode.ts   # intent_node：本地 NLI 意图识别 + 问候/开发关键词规则短路
│   │   └── routeNode.ts    # route_node：按 top-1/top-2 间距分流 chat / team
│   ├── route.ts            # routeAfterPreprocess（分流条件边）+ routeToWhichAgent（agent 间条件边）
│   ├── checkpointer.ts     # PostgresSaver 单例 + deleteThreadCheckpoints（崩溃恢复）
│   ├── state.ts            # AgentStateAnnotation（Annotation.Root）
│   └── streamEvents.ts     # NodeStreamChunk（节点自定义流事件类型）
├── database/
│   ├── index.ts            # 汇总导出
│   ├── connection/
│   │   ├── client.ts       # pg.Pool 单例 + pingDb + 建表/扩展/索引
│   │   └── constants.ts    # 表名 <prefix>_<agent>
│   ├── models/
│   │   ├── embedding.ts    # 本地 ONNX embedding
│   │   ├── reranker.ts     # 本地 cross-encoder rerank（含降级）
│   │   └── intentClassifier.ts  # 本地 zero-shot NLI 意图分类（懒加载单例）
│   ├── retrieval/
│   │   └── rag_retriever.ts # 关键字 + 向量并行召回 → 去重 → rerank；getRetriever(name) 缓存
│   ├── ingestion/
│   │   ├── initializer.ts  # buildAgentsTables / loadSeedsToPg / resetAgentDb（幂等灌库）
│   │   ├── loaders.ts      # JSON/MD/PDF/DOCX/TXT 五种 loader
│   │   └── splitters.ts    # 按 type 切块
│   ├── chat/chatStore.ts   # sessions / messages 持久化（含 tool_calls jsonb、上下文压缩摘要列）
│   └── users/userStore.ts  # users 表：账号鉴权 + 个人记忆读写
├── tools/
│   ├── toolRegister.ts     # ToolRegister 类 + 单例 + 本地工具登记 + allTools
│   ├── ragSearchTool.ts / readFileTool.ts / listDirTool.ts / globTool.ts / grepTool.ts
│   ├── echoTool.ts / processTool.ts / fileEditTool.ts / writeFileTool.ts / webFetchTool.ts / skillTool.ts
│   ├── pathAuth.ts         # 文件类工具的路径授权 / 越界防护
│   └── mcp/mcpClient.ts    # MultiServerMCPClient 接入 + JSON-Schema→zod shim
├── server/
│   ├── httpServer.ts       # POST /api + GET /events
│   ├── rpcServer.ts        # handleRpc 按 method 分诊（chat.* / session.* / user.* / model.* / toolApproval）
│   ├── runExecution.ts     # 跑 / 续跑一轮讨论，graph.stream → SSE，增量落库
│   ├── sseServer.ts        # SSE 长连登记表 + send()
│   ├── sessions.ts         # 会话运行时状态（busy + AbortController，内存）
│   ├── toolApprovals.ts    # HITL 工具审批：挂起 Promise + createPending/resolve
│   ├── compaction.ts       # 上下文压缩：滚动总结较早历史
│   ├── titleSummary.ts     # 会话自动命名（首条输入 → 短标题）
│   └── meetingSummary.ts   # 会议结束整理
├── config/
│   ├── settings.ts         # zod Settings 单例（读 .env + 相对路径锚定）+ 模型热切换覆盖
│   └── constants.ts        # AGENT_NAMES / ASSISTANT / INTENT_LABELS / 规则白名单 / isAgentName
├── skills/                 # skill 工具读取的 <name>/SKILL.md
└── utils/                  # logger / utils（printAgentInfo / cleanBadChars 等）
```

> 种子文件在仓库根 `data/seed/<agent>/`，模型缓存在根 `models/`，`.env` 在根——两个 app 共享。`PROJECT_ROOT` 由 `config/settings.ts` 向上四级（config→src→runtime→apps）到仓库根。

---

## 开发常用

```bash
# 重置某个 agent 的表并重灌
pnpm exec tsx -e "import('./src/database/ingestion/initializer.ts').then(m => m.resetAgentDb('backend'))"

# 完全抹库重灌（删 docker volume，下次启动重建）
docker compose down -v && docker compose up -d   # 在仓库根
```

环境变量见根 `.env.example`。检索参数 `RETRIEVE_TOP_N` / `RERANK_TOP_N`、MCP 端点 `BAIDU_SEARCH_MCP_URL` / `BAIDU_SEARCH_API_KEY` 都在 `.env`。
