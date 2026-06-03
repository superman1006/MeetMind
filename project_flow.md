# MeetMind 项目调用流程

> TypeScript monorepo（ESM + NodeNext，用 `tsx` 直接跑 `.ts`，包管理用 `pnpm`）。
> 两个 app：
> - **`apps/runtime`** —— 后端，多 Agent 讨论 + RAG + 持久化，对外开一个 HTTP/SSE 服务（端口 3002）。
> - **`apps/desktop`** —— 前端，Vue 3 + Vite + Tauri 外壳，通过 `POST /api`（JSON-RPC）发指令、`GET /events`（SSE）收讨论流。
>
> 本文档主要讲 **runtime 的调用链**；末尾给出与前端之间的 SSE 事件契约。
> 存储为 **PostgreSQL（pgvector 向量 kNN + pg_trgm 关键字召回）**，rerank / embedding 都是本地 ONNX 模型。

---

## 一、进程入口 `apps/runtime/src/index.ts`

```
index.ts（进程入口，HTTP/SSE 服务）
  ├── import { config } from "dotenv"; config()      # 必须先 load .env，再 import 主逻辑
  ├── process.on("unhandledRejection" / "uncaughtException")
  │     # 兜底：漏网的 Promise rejection / 同步异常只记日志，不让长跑的服务进程退出
  ├── const { bootstrap }   = await import("./bootstrap.js")
  ├── const { buildGraph }  = await import("./graph/builder.js")
  ├── const { startServer } = await import("./server/httpServer.js")
  │
  ├── await bootstrap()         # 自检 + 灌库（见第二节）
  ├── const graph = buildGraph()# 编译 LangGraph，只做一次，所有会话复用
  └── startServer(graph, 3002)  # 起 HTTP 服务（见第三节）
```

`index.ts` 是薄壳：先保证 dotenv 加载，再**动态** import 主逻辑（让 LangSmith 等在 import 期读 env 的 SDK 拿到配置），然后 bootstrap → 编图 → 起服务。

> `apps/runtime/src/config/settings.ts` 在 import 期也会自行 `loadDotenv(PROJECT_ROOT/.env)`，
> 所以单独 import 某个模块跑脚本（如 reset）时配置也能读到 .env，不依赖 index.ts。
> CLI 仍在 `apps/runtime/src/cli/main.ts` 保留，可用 `pnpm --filter @meetmind/runtime dev:cli` 单独跑（非流式、无服务）。

---

## 二、启动自检 `bootstrap()`

```
bootstrap()                              # apps/runtime/src/bootstrap.ts
  ├── setupLogging()
  ├── getSettings()                      # 读 .env，zod 校验 + 缓存成单例；打印全部配置项（key/token 脱敏）
  ├── pingDb()                           # PostgreSQL SELECT 1；不可达 → process.exit(1)（唯一硬退出）
  ├── ensureChatTables()                 # 建 sessions / messages 两张表（幂等，见第十五节）
  ├── 打印本地 Rerank 模型信息           # 本地 cross-encoder，无需 key
  ├── 打印 LangSmith 追踪状态            # 看 LANGSMITH_TRACING 环境变量
  ├── getEmbedderModel()                 # 预热 @huggingface/transformers embedding 模型（lazy 单例）
  ├── buildAgentsTables()                # 建表 + 灌种子到 PostgreSQL（见第十二节）
  └── for agent of AGENT_NAMES: countDocs(agent)   # 打印各 agent 表里文档总数
```

> 启动唯一的硬退出是 `pingDb()` 失败。LLM 的 key/baseUrl 缺失不会在启动时拦截（zod 给空串默认值），
> 会在第一次调用模型时才抛错。

---

## 三、HTTP 服务 `startServer(graph, port)`

`apps/runtime/src/server/httpServer.ts` 用 `node:http` 起服务，对外开两个窗口：

```
createServer((req, res) => ...)          # 每来一个请求跑一次
  ├── setCors(res)                       # 加 CORS 头（主要给 Tauri 打包后的窗口用）
  ├── OPTIONS                → 204 放行（浏览器跨域预检）
  ├── POST /api              → handleApi(graph, req, res)
  │     ├── readBody → JSON.parse（失败回 -32700）
  │     ├── handleRpc(graph, body)       # 按 method 分诊干活（见第四节）
  │     └── res.end(JSON.stringify(result))
  ├── GET  /events           → handleEvents(req, res, url)
  │     ├── 必带 ?sessionId，否则 400
  │     ├── 写 SSE 响应头 + 一帧 ": connected"
  │     ├── addClient(sessionId, res)    # 登记长连（见 server/sse.ts）
  │     └── req.on("close") → removeClient(...)
  └── 其它                   → 404
```

- **`/api`** 是一问一答的 JSON-RPC，立即返回。
- **`/events`** 是订阅式长连，不 `res.end`，讨论过程中业务代码用 `sse.send(sessionId, ...)` 往里推。

---

## 四、RPC 分诊 `handleRpc(graph, body)`

`apps/runtime/src/server/rpc.ts` 按 `body.method` 分发。慢任务（讨论、整理）**不 await**，立即回 `{ok:true}`，真正内容走 SSE：

```
handleRpc(graph, { method, params, id })
  ├── chat.send         # 开一轮讨论
  │     ├── 校验 sessionId + requirement（非空字符串，否则 -32602）
  │     ├── isSessionEnded? → -32000（会议已结束，DB 持久化的兜底）
  │     ├── isBusy?         → -32000（同会话一次只能跑一轮）
  │     ├── setBusy(true) + new AbortController + setController
  │     ├── runDiscussion(graph, sessionId, requirement, signal)   # ← 不 await（见第五节）
  │     │     .catch(记日志).finally(清 busy + controller)         # 必须 .catch，否则拖垮进程
  │     └── return { ok:true }
  │
  ├── chat.interrupt    # 打断进行中的讨论
  │     └── getController(sessionId)?.abort()    # 让 graph.stream 抛错，本轮丢弃；幂等
  │
  ├── chat.end          # 结束会议 → 后台整理纪要
  │     ├── isSessionEnded? / isBusy? → 拒绝
  │     ├── markSessionEnded(sessionId)          # 持久化「已结束」，此后锁定
  │     ├── setBusy(true)
  │     └── summarizeMeeting(sessionId)          # ← 不 await（见第十六节）
  │
  ├── session.create    → chatStore.createSession(title ?? "新会话")
  ├── session.list      → chatStore.listSessions()
  ├── session.messages  → chatStore.getMessages(sessionId)         # 前端渲染历史气泡
  ├── session.rename    → chatStore.renameSession(sessionId, title)
  ├── session.delete    → isBusy? 拒绝 : chatStore.deleteSession(sessionId)  # 级联删消息
  └── 未匹配            → -32601（未知方法）
```

> 会话运行时状态（busy 标记 + AbortController）在内存里，见 `apps/runtime/src/server/sessions.ts`，重启即重置。
> 消息 / 跨轮记忆持久化在 PostgreSQL（`chatStore`）。

---

## 五、一轮讨论 `runDiscussion(graph, sessionId, requirement, signal)`

`apps/runtime/src/server/runDiscussion.ts`：把图的流式输出转发成 SSE。

```
runDiscussion()
  ├── userTurn = { agent_name:"user", role:"用户", message:requirement, next_agent:architect, done:false, used_rag:false }
  ├── priorMessages = await chatStore.getMessages(sessionId)   # 跨轮记忆起点（首轮为空）
  ├── seedMessages  = [...priorMessages, userTurn]
  ├── initialState  = { requirement, messages: seedMessages, next_agent:null, done:false, iteration:0 }
  │
  ├── stream = await graph.stream(initialState, {
  │       recursionLimit: 50,
  │       streamMode: ["custom","values"],   # custom=节点发的自定义事件；values=每节点跑完的完整 state
  │       signal,                              # chat.interrupt abort() 透传到这里，中止 LLM + 图迭代
  │   })
  │
  ├── for await ([mode, chunk] of stream):
  │     ├── mode==="custom" → sse.send(sessionId, chunk.kind, chunk)   # turn_start / delta / using_tools / turn_end
  │     └── mode==="values" → finalState = chunk                       # 留最后一帧
  │
  ├── if signal.aborted:                       # 被打断 → 不落库（保留上一轮记忆），发 round_done(interrupted)
  │     └── sse.send("round_done", { done:false, interrupted:true }); return
  │
  ├── newTurns = finalState.messages.slice(priorMessages.length)   # 本轮新增 = userTurn + 各 agent 回复
  ├── await chatStore.appendMessages(sessionId, newTurns)          # 增量落库，不重写整段
  └── sse.send("round_done", { done: finalState.done })

  catch: signal.aborted 时同样按「打断」处理；其余异常 → sse.send("error", {message})
        （整个函数体在 try 里，绝不让 Promise reject 逃逸拖垮进程）
```

---

## 六、图编译 `buildGraph()`

```
buildGraph()                          # apps/runtime/src/graph/builder.ts
  ├── buildAllAgents()                # 实例化 5 个 Agent（无参构造）
  │     { architect: new ArchitectAgent(), backend: new BackendAgent(),
  │       frontend: new FrontendAgent(), tester: new TesterAgent(), pm: new PMAgent() }
  │       # 每个 BaseAgent 构造里：
  │       #   this.RAGRetriever = getRetriever(name)   ← 按 agent 名缓存的私有检索器（PascalCase 命名是刻意的）
  │       #   this._model = new ChatOpenAI({ ..., modelKwargs:{ thinking:{ type:"disabled" } } })  ← 关思考模式，不能删
  │       #   this._modelWithTools = this._model.bindTools(allTools)   ← 构造阶段一次性绑工具
  │
  ├── new StateGraph(AgentStateAnnotation)
  ├── for name of AGENT_NAMES: addNode(`${name}_node`, createNode(agent))   # 每个 agent 一个节点（见第八节）
  ├── addEdge(START, `${ARCHITECT}_node`)                                   # 固定入口：总从架构师开始
  ├── for name of AGENT_NAMES: addConditionalEdges(`${name}_node`, routeToWhichAgent, routeMap)
  │     # 每个节点出口都挂同一个路由函数；routeMap 把返回值映射到实际节点 + END
  └── graph.compile()
```

---

## 七、节点执行 `createNode(agent)` 返回的闭包

`apps/runtime/src/graph/builder.ts`。节点跑 agent 并把过程通过 `config.writer` 发成自定义流事件（runDiscussion 转成 SSE）：

```
async (state, config) => {...}
  ├── requirement = state.requirement;  history = formatHistory(state.messages)   # 历史拼成文本喂 agent
  ├── iteration = (state.iteration ?? 0) + 1;  turnId = `${agent.name}-${iteration}`
  │
  ├── writer = config.writer            # 有 writer（服务端流式）才发事件；无 writer（CLI）退回非流式
  ├── writer?.({ kind:"turn_start", turnId, agent_name, role })
  ├── onDelta(text)   = writer({ kind:"delta", turnId, text })          # Phase 2 每多吐一截 content 就推一次
  ├── onToolUse(name) = writer({ kind:"using_tools", turnId, tool:name }) + toolsUsed.push(name)  # 工具执行前推
  │
  ├── response = await agent.invoke(requirement, history, { onDelta, onToolUse })   # ← 核心（见第九节）
  ├── if toolsUsed.length: response.tool = toolsUsed.join(", ")         # 本轮用过的工具名随消息落库
  ├── printAgentInfo(...)               # 控制台美化输出
  ├── writer?.({ kind:"turn_end", turnId, next_agent, done, used_rag })
  │
  └── return {                          # 只回增量，LangGraph 按 Annotation 合并进 state
        messages: [response],           # concat reducer → 追加（整条 AgentResponse 直接进历史）
        next_agent: response.next_agent,
        done: response.done,
        iteration,
      }
```

---

## 八、Agent 推理核心 `BaseAgent.invoke()`（两阶段）

`apps/runtime/src/agents/base.ts`。子类只重写 `get systemPrompt()`，公共能力都在这里。

```
BaseAgent.invoke(requirement, history, opts?={ onDelta, onToolUse })
  │
  ├── cleanBadChars(requirement / history / prompts)   # 清除孤立 UTF-16 surrogate 码点
  ├── this.RAGRetriever.restart()                      # 清零本轮 callCount（供 used_rag 统计）
  ├── Allmessages = [ SystemMessage(systemPrompt + _routingPrompt()),
  │                   HumanMessage(_userPrompt(requirement, history)) ]
  │
  ├── ===== Phase 1：工具循环（复用构造阶段已 bindTools 的 _modelWithTools，不约束输出格式）=====
  │     for i in 0.._MAX_TOOL_ITERATIONS(=3):
  │         aiMsg = await this._modelWithTools.invoke(Allmessages); Allmessages.push(aiMsg)
  │         if aiMsg.tool_calls 为空: break              # LLM 不再要工具 → 进收尾
  │         for tc of tool_calls:
  │             toolToRun = allTools.find(t => t.name === tc.name)
  │             opts.onToolUse?.(tc.name)                # 执行前通知前端常驻 "UsingTools: <工具名>"
  │             out = await toolToRun.invoke(tc.args, { configurable:{ agentName: this.name } })  # 见第十、十一节
  │             Allmessages.push(new ToolMessage({ content: out, tool_call_id: tc.id }))
  │     # 跑满 3 轮仍要工具 → 强制进 Phase 2（warning 一条）
  │     # Phase 1 整体抛错 → 返回兜底 AgentResponse(next_agent=architect, done=false)
  │
  └── ===== Phase 2：结构化收尾（只 withStructuredOutput，不带工具）=====
        Allmessages.push(HumanMessage(structurePrompt))      # 要求按 ModelOutput 三字段汇总
        structuredModel = this._model.withStructuredOutput(ModelOutputSchema, { name:"ModelOutput" })
        if opts.onDelta:                                     # 服务端：流式收尾
            partialStream = await structuredModel.stream(Allmessages)
            finalOutput = await streamStructuredContent(partialStream, opts.onDelta)   # 逐段吐 content 增量（打字机）
        else:                                                # CLI：一次拿完整结果
            finalOutput = await structuredModel.invoke(Allmessages)
        # 抛错时兜底 finalOutput = { content:"(失败)", next_agent:architect, done:"false" }

  最终 _buildAgentResponse(finalOutput):
        ├── done 字符串 → bool（"true"/"yes"/"1"/"y"/"done"/"完成" 视为 true）
        ├── next_agent 不在 AGENT_NAMES → 兜底 architect（保证图不卡死）
        └── 返回 AgentResponse { agent_name, role, message, next_agent, done, used_rag }
              # used_rag = (this.RAGRetriever.callCount > 0)
```

> 路由协议是 **zod 结构化输出** `ModelOutputSchema = { content, next_agent, done }` + `withStructuredOutput`，
> 解析 / 兜底都在 `_buildAgentResponse`（没有正则版的 `_getNextAgent`）。
> 两阶段分开是因为「边调工具边强制结构化」在很多 OpenAI 兼容后端上不稳。

---

## 九、工具层 `apps/runtime/src/tools/`

每个工具是一个 `<xxx>Tool.ts` 导出的 LangChain `tool()` 单例，由 `ToolRegister` 收集成 `allTools`，BaseAgent 构造阶段 `bindTools(allTools)`：

```
toolRegistry.ts        # ToolRegister 类：register(tool) → push 进 allTools
base.ts                # const toolRegister = new ToolRegister();
                       #   toolRegister.register(ragSearchTool); toolRegister.register(webSearchTool)
                       #   const allTools = toolRegister.allTools

ragSearchTool.ts       # 名字 rag_search —— 私有 RAG，按调用时 config.configurable.agentName
                       #   getRetriever(agentName).retrieve(query)（见第十节）查对应 agent 的私有表
webSearchTool.ts       # 名字 web_search —— 走百度 AI Search MCP（SSE 传输，上游工具名 AIsearch）
                       #   与 agent 无关；模块级懒加载单例连接；未配 key / 连接失败时返回提示串而不抛错
```

---

## 十、RAG 检索 `RAGRetriever.retrieve(query)`

`apps/runtime/src/database/rag_retriever.ts`。**关键字 + 向量并行召回 → 合并去重 → 本地 cross-encoder rerank**：

```
retrieve(query, topN = rerankTopN(默认5))
  │   callCount += 1                          # 记一次调用，供 used_rag
  │
  ├── 1) 两路【并行】检索（Promise.all），各捞 candidateN = retrieveTopN(默认20) 条
  │     ├── VectorSearch(query, candidateN)            # 向量 kNN（pgvector）
  │     │     ├── queryVec = await embed(query)        ← 本地算 384 维向量
  │     │     └── SELECT id, content, metadata, 1-(embedding <=> $1::vector) AS score
  │     │           FROM <table> ORDER BY embedding <=> $1::vector LIMIT $2   # cosine 距离算子 <=>
  │     └── KeyWordSearch(query, candidateN)           # 关键字召回（pg_trgm）
  │           └── SELECT id, content, metadata, word_similarity($1, content) AS score
  │                 FROM <table> WHERE word_similarity($1, content) > 0 ORDER BY score DESC LIMIT $2
  │     # 任一路 SQL 抛错只 warning 并返回 []，另一路仍独立工作
  │
  ├── 2) merge(keywordHits, vectorHits)       # 按行 id 取并集去重（关键字在前，向量补后）；空则返回 []
  │
  └── 3) reranker.rerank(query, contents, finalN=topN)    # apps/runtime/src/database/reranker.ts
        ├── 本地 cross-encoder（@huggingface/transformers，默认 Xenova/bge-reranker-base，dtype=q8）
        │     逐条算 query↔候选 的 logit → sigmoid 当 relevanceScore，按分数降序取前 finalN
        └── 失败兜底：原序返回前 finalN 条（score=0），不让链路断

  → 回组 RetrievedDoc{ content, metadata, relevanceScore }；工具再拼成文本给 LLM
    （命中 0 条时返回 "(知识库中未找到相关条目)"）
```

> 候选数 / 返回数由 `RETRIEVE_TOP_N=20`、`RERANK_TOP_N=5` 控制（Settings）。

---

## 十一、灌库 `buildAgentsTables()` → `loadSeedsToPg(agent)`

`apps/runtime/src/database/initializer.ts`：

```
buildAgentsTables()                         # bootstrap 里调；返回每 agent 本次新增条数
  ├── ensureExtensions()                    # 建 vector(pgvector) + pg_trgm 两个扩展
  └── for agent of AGENT_NAMES:
        loadSeedsToPg(agent)                # 单 agent 灌库核心
          ├── getSeedsContent(agent)              # 扫 data/seed/<agent>/，loadFile() 按后缀分发
          │     # loaders.ts: loadJson / loadMarkdown / loadPdf(pdfjs) / loadDocx(mammoth) / loadText
          │     # 目录不存在时回退旧布局 data/seed/<agent>_seeds.json
          ├── splitDocs(contents)                 # splitters.ts，按 doc.type 二次切块（@langchain/textsplitters）
          ├── ensureAgentTable(agent)             # client.ts：建表 <prefix>_<agent>
          │     # 列 id text 主键 / content text / metadata jsonb / embedding vector(dim)
          │     # 建表前 getEmbedModelDim() 探维度；建 HNSW 向量索引 + GIN trigram 索引
          ├── getExistingIds(agent)               # 取现有 id 集合（幂等去重）
          ├── docId = `${agent}_${md5(content)[:12]}`   # 内容 hash 作主键 → 幂等，跳过已存在
          ├── embedBatch(newContents)             # embedding.ts：本地 ONNX 算 384 维向量
          └── INSERT ... ON CONFLICT (id) DO NOTHING

resetAgentDb(agent)                         # 开发者工具：deleteAgentTable + loadSeedsToPg（重灌单 agent）
```

---

## 十二、路由决策 `routeToWhichAgent(state)`

```
routeToWhichAgent(state)               # apps/runtime/src/graph/route.ts
  │   （被所有节点的条件边调用，返回值经 routeMap 映射到节点 / END）
  ├── iteration >= maxIterations    → END          # 安全上限（默认 15）
  ├── state.done === true           → END          # 架构师宣布完成
  ├── isAgentName(state.next_agent) → `${next}_node`
  └── 默认                          → `${ARCHITECT}_node`   # 兜底回架构师
```

---

## 十三、状态定义 `AgentStateAnnotation`

```ts
// apps/runtime/src/graph/state.ts —— LangGraph Annotation.Root，带 reducer 的共享 state
export const AgentStateAnnotation = Annotation.Root({
  requirement: Annotation<string>({ reducer: (_e, u) => u, default: () => "" }),            // 整轮不变
  messages:    Annotation<AgentResponse[]>({ reducer: (e, u) => e.concat(u), default: () => [] }), // 只追加
  next_agent:  Annotation<string | null>({ reducer: (_e, u) => u, default: () => null }),
  done:        Annotation<boolean>({ reducer: (_e, u) => u, default: () => false }),
  iteration:   Annotation<number>({ reducer: (_e, u) => u, default: () => 0 }),
});
export type AgentState = typeof AgentStateAnnotation.State;
```

> `messages` 直接存 `AgentResponse[]`（`apps/runtime/src/agents/base.ts` 的接口），没有单独的 `MessageTurn`。
> `AgentResponse` 字段：`agent_name / role / message / next_agent / done / used_rag / tool? / created_at?`
> （`next_agent` / `agent_name` / `used_rag` / `done` 刻意 snake_case，会序列化进 state；`created_at` 只读、仅 `getMessages` 回填）。

---

## 十四、持久化 `chatStore`（PostgreSQL）

`apps/runtime/src/database/chatStore.ts`。两张表，与 agent 表共用同一个 pool：

```
sessions   ( id text 主键, title text, created_at timestamptz, ended boolean )
messages   ( id bigserial 主键, session_id text → sessions(id) ON DELETE CASCADE,
             seq int, agent_name, role, message, next_agent, done, used_rag, tool, created_at )
             # 一条 messages 行 = 一条 AgentResponse；建 (session_id, seq) 联合索引

ensureChatTables()   # bootstrap 调；CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN IF NOT EXISTS（兼容旧表补 ended/tool 列）
createSession(title) → { id(randomUUID), title, created_at, ended:false }
listSessions()       → 按 created_at DESC
getMessages(id)      → 按 seq ASC（回填 created_at 给前端展示发送时间）
appendMessages(id, turns)  → seq 接已有最大值往后排，增量插入
renameSession / markSessionEnded / isSessionEnded / deleteSession(级联删消息)
```

---

## 十五、会议结束整理 `summarizeMeeting(sessionId)`

`apps/runtime/src/server/meetingSummary.ts`（由 `chat.end` 触发，不 await，进度走 SSE）：

```
summarizeMeeting(sessionId)
  ├── messages = await chatStore.getMessages(sessionId)    # 空则 sse.send("summary_error")
  ├── transcript = formatTranscript(messages)              # 整轮转录拼成纯文本
  ├── architect = getSummaryAgents()[ARCHITECT]            # 与图各持一套无状态 agent，不走 RAG
  ├── summary = await architect.summarizeAll(transcript)   # ★ 单次 LLM 调用同时产出 minutes + 各角色工作段
  │     # base.ts: withStructuredOutput(MeetingSummarySchema)，平铺 { minutes, <每个 agent 名>: 工作段 }
  │     # 取代旧版「架构师 1 次纪要 + 5 个角色各 1 次」共 6 次调用；失败返回占位结构而非抛出
  ├── md = composeSummaryMarkdown(sessionId, minutes, works, generatedAt)   # 纯函数组装整份 markdown
  ├── writeFile(<PROJECT_ROOT>/data/summary/<sessionId>.md, md)
  └── sse.send("summary_done", { file })                   # 失败则 sse.send("summary_error", { message })
```

---

## 十六、配置层 `getSettings()`

```
getSettings()                          # apps/runtime/src/config/settings.ts
  └── SettingsSchema.parse(process.env 过滤后)（zod 校验 + 缓存为单例；import 期已 loadDotenv）
        ├── LLM            : apiKey / baseUrl / modelName / maxTokens / temperature
        ├── 种子           : seedDataPath（相对路径锚定到 PROJECT_ROOT）
        ├── PostgreSQL     : pgUrl / pgTablePrefix          # 表名 <prefix>_<agent>
        ├── Embedding      : embeddingModelName / embeddingCacheDir
        ├── 本地 Rerank    : rerankModelName / rerankDtype
        ├── 检索参数       : retrieveTopN(20) / rerankTopN(5)
        ├── Web 搜索       : baiduSearchMcpUrl / baiduSearchApiKey
        └── 运行时         : logLevel / maxIterations(15)
        # env 名按 .env 全大写 SNAKE（API_KEY / PG_URL / ...）；seedDataPath、embeddingCacheDir 经 resolveRel 锚定根目录
```

`PROJECT_ROOT` 从 `settings.ts` 向上四级（config→src→runtime→apps）到仓库根，`data/` `models/` `.env` 都在根、两个 app 共享。

---

## 十七、SSE 事件契约（runtime → desktop）

`runDiscussion` 把节点发的 custom 帧（`apps/runtime/src/graph/streamEvents.ts` 的 `NodeStreamChunk`）按 `kind` 原样转成同名 SSE 事件，外加几个流程事件：

| SSE event | 何时发 | 负载 |
|---|---|---|
| `turn_start`  | 某 agent 节点开始 | `{ turnId, agent_name, role }` |
| `delta`       | Phase 2 流式收尾每多吐一截 | `{ turnId, text }` |
| `using_tools` | 工具执行前 | `{ turnId, tool }` |
| `turn_end`    | 某 agent 节点结束 | `{ turnId, next_agent, done, used_rag }` |
| `round_done`  | 一轮讨论结束 | `{ done }` 或 `{ done:false, interrupted:true }` |
| `error`       | 讨论中异常 | `{ message }` |
| `summary_done`/`summary_error` | 会议整理完成 / 失败 | `{ file }` / `{ message }` |

---

## 十八、文件与模块索引（`apps/runtime/src/`）

| 文件 | 职责 |
|------|------|
| `index.ts` | 进程入口：load dotenv → bootstrap → buildGraph → startServer(3002) |
| `bootstrap.ts` | 启动自检：pingDb / ensureChatTables / 预热 embedding / buildAgentsTables / countDocs |
| `server/httpServer.ts` | HTTP 服务：POST /api（JSON-RPC）+ GET /events（SSE）|
| `server/rpc.ts` | `handleRpc` 按 method 分诊（chat.* / session.*）|
| `server/runDiscussion.ts` | 跑一轮讨论，graph.stream 转 SSE，增量落库 |
| `server/sse.ts` | SSE 长连登记表 + `send(sessionId, event, data)` |
| `server/sessions.ts` | 会话运行时状态：busy 标记 + AbortController（内存）|
| `server/meetingSummary.ts` | 会议结束整理：summarizeAll → 写 data/summary/<id>.md |
| `config/settings.ts` | zod Settings 单例（读 .env + 相对路径锚定）、PROJECT_ROOT |
| `config/constants.ts` | AGENT_NAMES、角色常量、`isAgentName()` |
| `agents/base.ts` | BaseAgent 抽象类：invoke() 两阶段 + cleanBadChars + ModelOutputSchema + summarizeAll |
| `agents/{architect,backend,frontend,tester,pm}.ts` | 5 个角色子类（只重写 systemPrompt）|
| `agents/streamStructured.ts` | `streamStructuredContent`：流式结构化输出逐段吐 content 增量 |
| `graph/builder.ts` | buildGraph()、buildAllAgents()、节点工厂 createNode()、formatHistory() |
| `graph/route.ts` | routeToWhichAgent()，条件边路由逻辑 |
| `graph/state.ts` | AgentStateAnnotation（Annotation.Root）|
| `graph/streamEvents.ts` | NodeStreamChunk（节点发的自定义流事件类型）|
| `database/client.ts` | getPgPool() / pingDb() / ensureExtensions() / ensureAgentTable() / countDocs() / deleteAgentTable() |
| `database/constants.ts` | getTableName(agent) → `<prefix>_<agent>` |
| `database/embedding.ts` | getEmbedderModel() / getEmbedModelDim() / embed() / embedBatch() —— 本地 ONNX embedding |
| `database/reranker.ts` | rerank() —— 本地 cross-encoder（含失败降级）|
| `database/initializer.ts` | buildAgentsTables() / loadSeedsToPg(agent) / resetAgentDb(agent) —— 灌种子（幂等）|
| `database/loaders.ts` | loadFile() —— 按扩展名分发到各格式 loader |
| `database/splitters.ts` | splitDocs() —— 按 doc.type 切块 |
| `database/rag_retriever.ts` | RAGRetriever —— VectorSearch + KeyWordSearch 并行 + 本地 rerank；getRetriever(name) 缓存 |
| `database/chatStore.ts` | sessions / messages 持久化 |
| `tools/toolRegistry.ts` | ToolRegister 类，收集 allTools |
| `tools/ragSearchTool.ts` | rag_search 工具（私有 RAG，按 config.configurable.agentName 分 agent）|
| `tools/webSearchTool.ts` | web_search 工具（百度 AI Search MCP）|
| `utils/utils.ts` | printAgentInfo() / printBanner() / cleanBadChars() 等 |
| `utils/logger.ts` | getLogger() / setupLogging() |
| `data/seed/<agent>/` | 各 agent 种子文件目录（json / pdf / docx / md / txt）|
| `models/` | 本地模型缓存（embedding + reranker 的 ONNX 权重）|

---

## 附：依赖关系一览

```
                     ┌──────────────────────────────────┐
                     │  index.ts  (dotenv → 动态 import) │
                     └──────────────┬───────────────────┘
        ┌───────────────────────────┼────────────────────────────┐
        ▼                           ▼                            ▼
   bootstrap                  buildGraph                   startServer(graph, 3002)
        │                           │                            │
        ├── pingDb                  ├── buildAllAgents           ├── POST /api → handleRpc
        ├── ensureChatTables       │     └── new XxxAgent()      │     ├── chat.send → runDiscussion (不 await)
        ├── getEmbedderModel       │           ├── RAGRetriever  │     ├── chat.interrupt → controller.abort()
        ├── buildAgentsTables       │           └── ChatOpenAI    │     ├── chat.end → summarizeMeeting (不 await)
        │   └── loadSeedsToPg       │                 +bindTools  │     └── session.*  → chatStore
        │       ├── loadFile        ├── addNode(createNode)       │
        │       ├── splitDocs       └── addConditionalEdges       └── GET /events → addClient (SSE 长连)
        │       ├── ensureAgentTable          │
        │       ├── embedBatch                ▼
        │       └── INSERT          runDiscussion → graph.stream(["custom","values"], signal)
        └── countDocs                         │
                                              ▼
                                   createNode(agent) 闭包  ──writer──▶ SSE: turn_start/delta/using_tools/turn_end
                                              │
                                              ▼
                                   agent.invoke(req, hist, {onDelta,onToolUse})
                                              ├── Phase1: _modelWithTools 工具循环
                                              │     └── rag_search → RAGRetriever.retrieve
                                              │           ├── VectorSearch  (embed + pgvector <=>)
                                              │           ├── KeyWordSearch (pg_trgm word_similarity)
                                              │           ├── merge (按 id 去重)
                                              │           └── rerank (本地 cross-encoder)
                                              │     └── web_search → 百度 AI Search MCP
                                              └── Phase2: withStructuredOutput(ModelOutput)
                                                    └── _buildAgentResponse → AgentResponse
                                                          │
                                              runDiscussion: appendMessages → SSE round_done
```
