# MeetMind 项目调用流程（TypeScript 版）

> 本仓库已从 Python 迁移到 **TypeScript**（ESM + NodeNext，用 `tsx` 直接跑 `.ts`，包管理用 `pnpm`）。
> 原 `meetmind/*.py` 已删除，所有逻辑在 `src/` 下。下面的流程对照新的 TS 源码。

## 一、顶层入口

```
src/index.ts（进程入口）
  ├── import { config } from "dotenv"; config()    # 必须先 load .env，再 import 主逻辑
  └── const { main } = await import("./cli/main.js")
        └── await main()
```

`src/index.ts` 只做一件事：保证 dotenv 已加载，再动态 import `src/cli/main.ts` 的 `main()`。
（对标旧 Python 端 `main.py` 中 `load_dotenv()` 必须先于 LangSmith 等 SDK import 的顺序约束。）

> 注意：`src/config/settings.ts` 在 import 期也会自行 `loadDotenv(PROJECT_ROOT/.env)`，
> 所以单独 import 某个模块跑脚本时配置也能读到 .env，不依赖 index.ts。

---

## 二、CLI 主函数 `main()` 的三个阶段

```
main()                                  # src/cli/main.ts
  ├── printAppBanner()          # 打印欢迎横幅 + 角色介绍（boxen + chalk）
  ├── await bootstrap()         # 初始化：配置、ES 健康检查、模型预热、灌库
  │     ├── setupLogging()
  │     ├── getSettings()               # 读 .env，返回 Settings 单例（zod 校验 + 缓存）
  │     ├── pingEs()                    # ES 不可达就 process.exit(1)
  │     ├── 打印本地 rerank 模型信息    # 本地 cross-encoder，无需 key
  │     ├── 打印 LangSmith 追踪状态     # 看 LANGSMITH_TRACING 环境变量
  │     ├── 扫描 data/seed/<agent>/     # 打印每个 agent 目录里有哪些种子文件
  │     ├── getEmbedderModel()          # 预热 @huggingface/transformers 模型 (lazy 单例)
  │     ├── buildAgentsIndices()        # 灌入种子数据到 ES（幂等，docId = <agent>_md5(content)[:12]）
  │     └── countDocs(agent)            # 读取各 agent index 文档总数（展示用）
  │
  ├── buildGraph()              # 编译 LangGraph 图（只做一次，整轮会话复用）
  │
  └── while (true):             # 主循环（Node readline/promises）
        ├── rl.question("> ")               # 等待架构师输入需求
        ├── quit/exit/q → 退出
        ├── runOneDiscussion(graph, req)    # 一轮讨论
        └── printRoundReview(state)         # 复盘本轮（发言数 + 是否 done）
```

> 启动唯一的硬退出是 ES ping 失败（`process.exit(1)`）。LLM 的 key/baseUrl 缺失不会在启动时拦截，
> 会在第一次调用模型时抛错。

---

## 三、启动初始化：`bootstrap()` → `buildAgentsIndices()`

```
bootstrap()
  └── buildAgentsIndices()                    # src/database/initializer.ts
        └── for agentName of AGENT_NAMES:      # 5 个 agent 依次处理
              └── loadSeedsToEs(agentName)             # 单 agent 灌库的核心函数
                    ├── getSeedsContent(agentName)     # 扫描 data/seed/<agent>/ 目录
                    │     └── loadFile(path)           # src/database/loaders.ts，按扩展名分发
                    │           ├── loadJson()         # → RawDoc[]
                    │           ├── loadMarkdown()     # → RawDoc[]（按 ## 标题或空行分块）
                    │           ├── loadPdf()          # → RawDoc[]（pdfjs-dist，每页一条）
                    │           ├── loadDocx()         # → RawDoc[]（mammoth，每段一条）
                    │           └── loadText()         # → RawDoc[]（按空行分段）
                    │     # 目录不存在时回退旧布局 data/seed/<agent>_seeds.json
                    │
                    ├── splitDocs(seedContents)        # src/database/splitters.ts
                    │     └── 按 doc.type 分组，调用对应切块函数（@langchain/textsplitters）
                    │           ├── splitJson()        # 不切，原样返回
                    │           ├── splitMarkdown()    # MarkdownTextSplitter
                    │           ├── splitPdf()         # RecursiveCharacterTextSplitter (600/80)
                    │           ├── splitDocx()        # RecursiveCharacterTextSplitter (500/60)
                    │           └── splitText()        # RecursiveCharacterTextSplitter (500/60)
                    │
                    ├── ensureAgentIndex(agentName)    # src/database/client.ts
                    │     └── 不存在则建 ES index，mapping 同时含：
                    │           ├── content   : text (standard 分词器)        ← BM25 检索字段
                    │           ├── embedding : dense_vector (dim, cosine)    ← kNN 检索字段
                    │           └── metadata  : {type, date, source} keyword
                    │
                    ├── getExistingIds(indexName)      # 取出现有 _id 集合（幂等去重）
                    │
                    ├── 跳过 docId 已存在的 chunk
                    │     docId = `${agent}_${md5(content)[:12]}`   # 内容 hash 作 _id → 幂等
                    │
                    ├── embedBatch(newContents)        # src/database/embedding.ts
                    │     └── @huggingface/transformers feature-extraction（本地 ONNX）
                    │           Xenova/all-MiniLM-L6-v2 → number[][]（384 维, mean pooling + 归一化）
                    │
                    └── client.helpers.bulk(...)       # @elastic/elasticsearch bulk helper
                          # refreshOnCompletion=true，一次写入 {content, embedding, metadata}
```

---

## 四、图编译：`buildGraph()`

```
buildGraph()                          # src/graph/builder.ts
  ├── buildAllAgents()                      # 实例化 5 个 Agent（无参构造）
  │     ├── new ArchitectAgent()
  │     ├── new BackendAgent()
  │     ├── new FrontendAgent()
  │     ├── new TesterAgent()
  │     └── new PMAgent()
  │         每个 Agent 的 BaseAgent 构造里：
  │           ├── this.RAGRetriever = new RAGRetriever(name)   ← 私有检索器（PascalCase 命名是刻意的）
  │           └── this._model = new ChatOpenAI({...})          ← 绑定 LLM（OpenAI 兼容协议）
  │                 modelKwargs: { thinking: { type: "disabled" } }   ← 对标 Python extra_body，不能删
  │
  ├── new StateGraph(AgentStateAnnotation)   # Annotation.Root 定义的有状态图
  │
  ├── graph.addNode(`${name}_node`, createNode(agent))
  │     # 为每个 agent 创建一个节点（闭包函数）
  │
  ├── graph.addEdge(START, `${ARCHITECT}_node`)
  │     # 固定入口：总从架构师开始
  │
  ├── graph.addConditionalEdges(`${name}_node`, routeToWhichAgent, routeMap)
  │     # 每个节点出口都挂同一个路由函数；routeMap 把返回值映射到实际节点 + END
  │
  └── graph.compile()                        # 返回可执行的编译图
```

---

## 五、一轮讨论：`runOneDiscussion(graph, requirement)`

```
runOneDiscussion()                    # src/cli/main.ts
  └── await graph.stream(initialState, { recursionLimit: 50, streamMode: "values" })
        # values 模式：每个节点跑完吐一次完整 state；for await 留最后一帧
        │
        ├── architect_node → routeToWhichAgent → backend_node
        ├── backend_node   → routeToWhichAgent → frontend_node（或其他）
        ├── ...
        └── 任意 agent_node → routeToWhichAgent → END（done 为真 或 iteration ≥ maxIterations）
```

---

## 六、单个节点执行：`createNode(agent)` 返回的闭包

```
async (state) => {...}                 # src/graph/builder.ts 中的闭包
  ├── 从 state 取 requirement + messages
  ├── formatHistory(messages)            # 拼成字符串，传给 agent
  ├── iteration = (state.iteration ?? 0) + 1
  ├── await agent.invoke(requirement, history)   # ← 核心调用（见下一节）
  ├── printAgentInfo(...)                # 控制台美化输出（boxen 面板）
  └── return {                           # 只返回增量，LangGraph 按 Annotation 合并进 state
          messages: [newTurn],           # concat reducer → 追加到 state.messages
          next_agent: response.next_agent,   # 覆盖
          done: response.done,               # 覆盖
          iteration,                         # 覆盖
      }
```

---

## 七、Agent 推理核心：`BaseAgent.invoke()`（两阶段）

```
BaseAgent.invoke(requirement, conversationHistory)     # src/agents/base.ts
  │
  ├── cleanBadChars(requirement / history / prompts)   # 清除孤立 UTF-16 surrogate 码点
  ├── this.RAGRetriever.restart()        # 清零本轮 callCount
  ├── ragTool = this.RAGRetriever.getTool()
  │     # LangChain tool()，名字为 rag_search_<agentName>
  │
  ├── messages = [ SystemMessage(systemPrompt + _routingPrompt()),
  │                HumanMessage(_userPrompt(requirement, history)) ]
  │
  ├── ===== Phase 1：工具循环（只 bindTools，不约束输出格式）=====
  │     modelWithTools = this._model.bindTools([ragTool])
  │     for i in 0.._MAX_TOOL_ITERATIONS(=5):
  │         aiMsg = await modelWithTools.invoke(messages); messages.push(aiMsg)
  │         if aiMsg.tool_calls 为空: break            # LLM 不再要工具 → 进收尾
  │         for tc of tool_calls:
  │             toolResult = await ragTool.invoke(tc.args)   # 见第八节
  │             messages.push(new ToolMessage({content: toolResult, tool_call_id: tc.id}))
  │     # 跑满 5 轮仍要工具会强制进 Phase 2（warning 一条）
  │     # Phase 1 整体抛错 → 返回兜底 AgentResponse(next_agent=architect, done=false)
  │
  └── ===== Phase 2：结构化收尾（只 withStructuredOutput，不带工具）=====
        messages.push(HumanMessage(wrapUpPrompt))      # 要求按 ModelOutput 汇总
        structuredModel = this._model.withStructuredOutput(ModelOutputSchema, {name:"ModelOutput"})
        finalOutput = await structuredModel.invoke(messages)   # → { content, next_agent, done }
        # 抛错时兜底 finalOutput = {content:"(失败)", next_agent:architect, done:"false"}

  最终 _buildAgentResponse(finalOutput):
        ├── done 字符串 → bool（"true"/"yes"/"1"/"y"/"done"/"完成" 视为 true）
        ├── next_agent 不在 AGENT_NAMES → 兜底 architect（保证图不卡死）
        └── 返回 AgentResponse { agent_name, role, message, next_agent, done, used_rag }
              # used_rag = (RAGRetriever.callCount > 0)
```

> 路由协议已从旧版的自然语言标记 `[NEXT_AGENT: x]` / `[DONE]` + 正则解析，
> 改为 **zod 结构化输出** `ModelOutputSchema = { content, next_agent, done }`。
> 不再有 `_get_next_agent` 正则函数，解析/兜底逻辑都在 `_buildAgentResponse` 里。

---

## 八、RAG 检索流程：`RAGRetriever.getTool()` → `retrieve(query)`

```
ragTool.invoke({ query })              # src/database/rag_retriever.ts
  └── retrieve(query, topN=rerankTopN)             # 默认 topN=5
        │   callCount += 1                          # 记一次调用，供面板标「用过 RAG」
        │
        ├── 1) BM25 + 向量两路【并行】检索（Promise.all）
        │     ├── knnSearch(query, candidateN=20)
        │     │     ├── queryVec = await embed(query)      ← 本地算 384 维向量
        │     │     └── es.search({ knn:{ field:"embedding", query_vector, k, num_candidates } })
        │     └── bm25Search(query, candidateN=20)
        │           └── es.search({ query:{ match:{ content: query } } })
        │     # 任一路失败只 warning 并返回 []，不中断
        │
        ├── 2) merge(bm25Hits, knnHits)
        │     └── 按 ES _id 取并集去重（BM25 在前，kNN 补充）；空则直接返回 []
        │
        └── 3) rerank(query, sourceContents, finalN=5)    # src/database/reranker.ts
              ├── 本地 cross-encoder（@huggingface/transformers）
              │     loadReranker() 单例：AutoTokenizer + AutoModelForSequenceClassification
              │     默认模型 Xenova/bge-reranker-base，dtype=q8（缓存复用 ./models/）
              │     tokenizer(queries, {text_pair: documents}) → model 前向 → logits
              │     每条候选取 logit → sigmoid 归一化到 0~1 作 relevanceScore
              ├── 失败兜底：异常时返回前 finalN 条原序（score=0），不让链路断
              └── 返回 [RerankedDoc{ index, relevanceScore }, ...] 按分数从高到低 取前 finalN

        → 按 reranked 顺序回组 RetrievedDoc{ content, metadata, relevanceScore }
        → tool 把每条过 asContextLine() 拼成 "- [type / date] content" 字符串给 LLM
          （命中 0 条时返回 "(知识库中未找到相关条目)"）
```

> **链路上的两个常量**（在 Settings 里可调）：
> - `RETRIEVE_TOP_N=20` —— BM25 / kNN 各自捞这么多候选送 rerank
> - `RERANK_TOP_N=5`    —— 本地 rerank 后给 LLM 的最终上下文条数

---

## 九、路由决策：`routeToWhichAgent(state)`

```
routeToWhichAgent(state)               # src/graph/route.ts
  │   （被所有节点的条件边调用，返回值经 routeMap 映射到节点 / END）
  │
  ├── iteration >= maxIterations   → END          # 安全上限（默认 15）
  ├── state.done === true          → END          # 架构师宣布完成
  ├── isAgentName(state.next_agent) → `${next}_node`
  └── 默认                          → `${ARCHITECT}_node`   # 兜底
```

---

## 十、状态定义：`AgentStateAnnotation`

```ts
// src/graph/state.ts —— LangGraph JS 用 Annotation.Root 定义带 reducer 的 state
export const AgentStateAnnotation = Annotation.Root({
  requirement: Annotation<string>({ reducer: (_e, u) => u, default: () => "" }),     // 整轮不变
  messages:    Annotation<MessageTurn[]>({ reducer: (e, u) => e.concat(u), default: () => [] }), // 只追加
  next_agent:  Annotation<string | null>({ reducer: (_e, u) => u, default: () => null }),
  done:        Annotation<boolean>({ reducer: (_e, u) => u, default: () => false }),
  iteration:   Annotation<number>({ reducer: (_e, u) => u, default: () => 0 }),
});
export type AgentState = typeof AgentStateAnnotation.State;

export interface MessageTurn {   // 字段名按 Python 端保持 snake_case（跨语言序列化一致）
  agent_name: string;
  role: string;
  message: string;
  next_agent: string | null;
}
```

---

## 十一、配置层：`getSettings()`

```
getSettings()                          # src/config/settings.ts
  └── SettingsSchema.parse(process.env 过滤后)（zod 校验 + 缓存为单例）
        ├── import 期已 loadDotenv(PROJECT_ROOT/.env)
        ├── 映射到字段（env 名仍是大写 SNAKE，不引别名）：
        │     LLM             : apiKey / baseUrl / modelName / maxTokens / temperature
        │     种子           : seedDataPath
        │     Elasticsearch  : esUrl / esApiKey / esIndexPrefix
        │     Embedding      : embeddingModelName / embeddingCacheDir
        │     本地 Rerank    : rerankModelName / rerankDtype
        │     检索参数       : retrieveTopN / rerankTopN
        │     运行时         : logLevel / maxIterations
        │
        └── .transform(resolveRel) 把相对路径锚定到 PROJECT_ROOT
              # seedDataPath、embeddingCacheDir：.env 里写 ./data/seed → <PROJECT_ROOT>/data/seed
```

---

## 十二、文件与模块索引

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 进程入口：load dotenv → 动态 import `cli/main.ts` |
| `docker-compose.yml` | 本地单节点 Elasticsearch（HTTP, 无鉴权, 开发用） |
| `src/cli/main.ts` | CLI 主循环、bootstrap、讨论驱动 |
| `src/config/settings.ts` | zod Settings 单例（读 .env + 相对路径锚定） |
| `src/config/constants.ts` | AGENT_NAMES、角色常量、`isAgentName()` |
| `src/agents/base.ts` | BaseAgent 抽象类，invoke() 两阶段 + cleanBadChars + ModelOutputSchema |
| `src/agents/architect.ts` | ArchitectAgent（兼入口 + 终止者） |
| `src/agents/backend.ts` | BackendAgent |
| `src/agents/frontend.ts` | FrontendAgent |
| `src/agents/tester.ts` | TesterAgent |
| `src/agents/pm.ts` | PMAgent |
| `src/graph/state.ts` | AgentStateAnnotation（Annotation.Root）+ MessageTurn |
| `src/graph/builder.ts` | buildGraph()、节点工厂 createNode()、formatHistory() |
| `src/graph/route.ts` | routeToWhichAgent()，条件边路由逻辑 |
| `src/database/client.ts` | getEsClient() / pingEs() / ensureAgentIndex() / countDocs() / deleteAgentIndex() |
| `src/database/constants.ts` | getIndexName(agent) → `<prefix>_<agent>` |
| `src/database/embedding.ts` | getEmbedderModel() / getEmbedModelDim() / embed() / embedBatch() —— @huggingface/transformers 本地 embedding |
| `src/database/reranker.ts` | rerank() —— 本地 cross-encoder（`Xenova/bge-reranker-base`，含失败降级） |
| `src/database/initializer.ts` | buildAgentsIndices() / loadSeedsToEs(agent) / resetAgentDb(agent) —— 种子灌入 ES（幂等，docId = `<agent>_md5(content)[:12]`） |
| `src/database/loaders.ts` | loadFile() —— 按扩展名分发到各格式 loader |
| `src/database/splitters.ts` | splitDocs() —— 按 doc.type 切块 |
| `src/database/rag_retriever.ts` | RAGRetriever —— ES BM25 + ES kNN 并行检索 + 本地 rerank；getTool() 暴露成 LangChain Tool |
| `src/utils/formatting.ts` | printAgentInfo() / printBanner() / printMessagesTable() —— chalk + boxen + cli-table3 美化输出 |
| `src/utils/logger.ts` | getLogger() / setupLogging() |
| `data/seed/<agent>/` | 各 agent 的种子文件目录（json / pdf / docx / md / txt） |
| `models/` | 本地模型缓存（embedding + reranker 的 ONNX 权重下载到这里） |
| ES index `<es_index_prefix>_<agent>` | ES 中按 agent 命名的 index，存 content + embedding + metadata |

---

## 附：依赖关系一览

```
                     ┌──────────────────────────────────┐
                     │   src/index.ts  (load dotenv)    │
                     └──────────────┬───────────────────┘
                                    │  import cli/main.ts
                     ┌──────────────┴───────────────────┐
                     │      cli/main.ts : main()        │
                     └──────────────┬───────────────────┘
                                    │
        ┌───────────────────────────┼────────────────────────────┐
        ▼                           ▼                            ▼
   bootstrap                  buildGraph                   runOneDiscussion
        │                           │                            │
        ├── pingEs                  ├── buildAllAgents           └── graph.stream
        ├── getEmbedderModel       │     ↓                             │
        ├── buildAgentsIndices      │     new ArchitectAgent(...)       ▼
        │   └── loadSeedsToEs       │     ...new PMAgent(...)      createNode(agent) 闭包
        │       ├── loadFile        │         │                        │
        │       ├── splitDocs       │         ├── RAGRetriever         ▼
        │       ├── ensureAgentIndex│         │                   agent.invoke(req, hist)
        │       ├── embedBatch      │         └── ChatOpenAI            │
        │       └── helpers.bulk    │                                  │
        └── countDocs               │                                  │
                                    └── addNode + addConditionalEdges ─→│
                                                                       ├── Phase1: bindTools([rag])
                                                                       │     └── ragTool.invoke
                                                                       │           └── RAGRetriever.retrieve
                                                                       │                 ├── knnSearch (ES + embed)
                                                                       │                 ├── bm25Search (ES)
                                                                       │                 ├── merge (按 _id 去重)
                                                                       │                 └── rerank (本地 cross-encoder)
                                                                       └── Phase2: withStructuredOutput
                                                                             └── _buildAgentResponse → AgentResponse
```
