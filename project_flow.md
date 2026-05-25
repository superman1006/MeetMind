# MeetMind 项目调用流程

## 一、顶层入口

```
main.py（5行薄壳）
  └── from meetmind.cli.main import main
      └── main()
```

`main.py` 只做一件事：调用 `meetmind/cli/main.py` 里的 `main()`。
真正的逻辑全在 `meetmind/cli/main.py`。

---

## 二、CLI 主函数 `main()` 的三个阶段

```
main()
  ├── _print_banner()           # 打印欢迎横幅和角色介绍
  ├── _bootstrap()              # 初始化：配置、ES 健康检查、模型预热、灌库
  │     ├── setup_logging()
  │     ├── get_settings()              # 读 .env，返回 Settings 单例（lru_cache）
  │     ├── ping_es()                   # ES 不可达就 sys.exit(1)
  │     ├── 校验 cohere_api_key         # 缺就 sys.exit(1)
  │     ├── 扫描 data/seed/<agent>/     # 打印每个 agent 目录里有哪些种子文件
  │     ├── get_embedder_model()        # 预热 sentence-transformers 模型 (lru_cache, 进程内只加载一次)
  │     ├── build_agents_indices()      # 灌入种子数据到 ES（幂等，doc_id = md5(content)[:12]）
  │     └── count_docs(agent)           # 读取各 agent index 文档总数（展示用）
  │
  ├── build_graph()       # 编译 LangGraph 图（只做一次）
  │
  └── while True:               # 主循环
        ├── console.input()     # 等待架构师输入需求
        ├── _run_one_discussion(graph, requirement)   # 一轮讨论
        └── _next_round_or_not(state)                 # 人类决定继续 or 退出
```

---

## 三、启动初始化：`_bootstrap()` → `build_agents_indices()`

```
_bootstrap()
  └── build_agents_indices()                  # meetmind/database/initializer.py
        └── for agent_name in AGENT_NAMES:    # 5 个 agent 依次处理
              └── load_seeds_to_es(agent_name)          # 单 agent 灌库的核心函数
              ├── _get_seeds_content(agent_name)        # 扫描 data/seed/<agent>/ 目录
              │     └── load_file(path)                 # meetmind/database/loaders.py
              │           ├── load_json()               # → list[dict]
              │           ├── load_markdown()           # → list[dict]
              │           ├── load_pdf()                # → list[dict]（每页一条）
              │           ├── load_docx()               # → list[dict]（每段一条）
              │           └── load_text()               # → list[dict]
              │
              ├── split_docs(seed_contents)             # meetmind/database/splitters.py
              │     └── 按 doc["type"] 分组，调用对应切块函数
              │           ├── split_json()              # 不切，原样返回
              │           ├── split_markdown()          # MarkdownHeaderTextSplitter → Recursive
              │           ├── split_pdf()               # RecursiveCharacterTextSplitter
              │           ├── split_docx()              # RecursiveCharacterTextSplitter
              │           └── split_text()              # RecursiveCharacterTextSplitter
              │
              ├── get_agent_index(agent_name)        # meetmind/database/client.py
              │     └── 不存在则建 ES index，mapping 同时包含：
              │           ├── content   : text (standard 分词器)        ← BM25 检索字段
              │           ├── embedding : dense_vector (384, cosine)    ← kNN 检索字段
              │           └── metadata  : {type, date, source} keyword
              │
              ├── _get_existing_ids(index_name)             # 取出现有 _id 集合（用于幂等去重）
              │
              ├── 跳过 doc_id 已存在的 chunk
              │     doc_id = md5(content)[:12]          # 内容 hash 作 _id → 幂等
              │
              ├── embed_batch(new_contents)             # meetmind/database/embedding.py
              │     └── SentenceTransformer.encode(...)         ← 本地 all-MiniLM-L6-v2
              │           → list[list[float]] (384 维, L2-normalized)
              │
              └── elasticsearch.helpers.bulk(client, actions, refresh="wait_for")
                    # 一次性 bulk index：{content, embedding, metadata} 三个字段同写
```

---

## 四、图编译：`build_graph()`

```
build_graph()                         # meetmind/graph/builder.py
  ├── _build_all_agents()                   # 实例化 5 个 Agent
  │     ├── ArchitectAgent()
  │     ├── BackendAgent()
  │     ├── FrontendAgent()
  │     ├── TesterAgent()
  │     └── PMAgent()
  │         每个 Agent 在 __init__ 里：
  │           ├── self.RAGRetriever = RAGRetriever(agent_name)
  │           │     └── get_agent_index(agent_name)   ← 顺便保证 index 已建
  │           └── self._model = ChatOpenAI(...)          ← 绑定 LLM（OpenAI 兼容协议）
  │
  ├── StateGraph(AgentState)                # 创建有状态的图
  │
  ├── graph.add_node(f"{name}_node", _create_node(agent))
  │     # 为每个 agent 创建一个节点（闭包函数）
  │
  ├── graph.add_edge(START, "architect_node")
  │     # 固定入口：总从架构师开始
  │
  ├── graph.add_conditional_edges(f"{name}_node", route_to_which_agent, route_map)
  │     # 每个节点出口都挂同一个路由函数
  │
  └── graph.compile()                       # 返回可执行的 CompiledGraph
```

---

## 五、一轮讨论：`_run_one_discussion(graph, requirement)`

```
_run_one_discussion()
  └── graph.stream(initial_state, stream_mode="values")
        # 每次 agent 发言后 stream 出最新完整 state（values 模式）
        # for state in graph.stream(...)  ← Python 迭代器协议，图执行一步返回一个 state
        │
        ├── architect_node → route_to_which_agent → backend_node
        ├── backend_node   → route_to_which_agent → frontend_node（或其他）
        ├── ...
        └── 任意 agent_node → route_to_which_agent → END（遇到 [DONE] 或超过 max_iterations）
```

---

## 六、单个节点执行：`_create_node(agent)` 返回的闭包

```
_node(state)                              # meetmind/graph/builder.py 中的闭包
  ├── 从 state 取 requirement + messages
  ├── _format_history(messages)           # 拼成字符串，传给 agent
  ├── agent.invoke(requirement, history)  # ← 核心调用（见下一节）
  ├── print_agent_info(...)               # 控制台美化输出（rich Panel）
  └── return {                            # 只返回增量，LangGraph 自动并入 state
          "messages": [new_turn],         # operator.add reducer → 追加到 state["messages"]
          "next_agent": ...,              # 覆盖
          "done": ...,                    # 覆盖
          "iteration": iteration,         # 覆盖
      }
```

---

## 七、Agent 推理核心：`BaseAgent.invoke()`

```
BaseAgent.invoke(requirement, conversation_history)    # meetmind/agents/base.py
  │
  ├── clean_bad_chars(requirement)         # 清除 UTF-16 surrogate 码点
  ├── clean_bad_chars(conversation_history)
  │
  ├── self.RAGRetriever.restart()          # 清零本轮 call_count
  ├── rag_tool = self.RAGRetriever.get_tool()
  │     # 返回 LangChain Tool，名字为 rag_search_<agent_name>
  │
  ├── model_with_tools = self._model.bind_tools([rag_tool])
  │     # 把 RAG 工具的 schema 注入到 LLM 的 function-calling 上下文
  │
  ├── 构造 messages 列表：
  │     ├── SystemMessage(self.system_prompt + self._routing_prompt())
  │     └── HumanMessage(self._user_prompt(requirement, history))
  │
  └── tool_calls 循环（最多 _MAX_TOOL_ITERATIONS=5 次）：
        ├── ai_msg = model_with_tools.invoke(messages)
        ├── tool_calls = getattr(ai_msg, "tool_calls", [])
        │
        ├── 如果 tool_calls 为空：
        │     final_text = ai_msg.content  → break
        │
        └── 如果有 tool_calls：
              └── for tc in tool_calls:
                    ├── 执行 rag_tool.invoke(tc["args"])
                    │     └── RAGRetriever.retrieve_as_context(query)  （见下一节）
                    └── 把结果包装成 ToolMessage 追加到 messages，继续下一轮
        
  最终调用 _get_next_agent(final_text)
        ├── 含 [DONE]           → (None, done=True)
        ├── 含 [NEXT_AGENT: x]  → (x, done=False)
        └── 解析失败            → (architect, done=False)  ← 兜底保证图不卡死
  
  返回 AgentResponse(agent_name, role, message, next_agent, done, used_rag)
```

---

## 八、RAG 检索流程：`RAGRetriever.retrieve_as_context(query)`

```
RAGRetriever.retrieve_as_context(query)            # meetmind/database/rag_retriever.py
  └── retrieve(query, top_n=rerank_top_n)          # 默认 top_n=5
        │
        ├── 1) BM25 检索: _bm25_search(query, size=retrieve_top_n)   # size 默认 20
        │     └── es.search(index, body={
        │             "query": {"match": {"content": query}},
        │             "_source": ["content", "metadata"],
        │             "size": 20
        │         })
        │     ← ES 内置 standard 分词器 + BM25 评分；返回 list[hit]
        │
        ├── 2) 向量检索: _knn_search(query, size=retrieve_top_n)     # size 默认 20
        │     ├── query_vec = embed(query)                          ← 本地算 384 维向量
        │     │     └── SentenceTransformer.encode(query, normalize=True)
        │     └── es.search(index, body={
        │             "knn": {
        │                 "field": "embedding",
        │                 "query_vector": query_vec,
        │                 "k": 20,
        │                 "num_candidates": max(100, 20*5)
        │             },
        │             "_source": ["content", "metadata"],
        │             "size": 20
        │         })
        │     ← cosine 相似度排序；返回 list[hit]
        │
        ├── 3) _merge_unique(bm25_hits, knn_hits)
        │     └── 按 _id 取并集去重；保持顺序（BM25 在前，kNN 补充）
        │     ← 通常合并后 20~40 条候选
        │
        └── 4) reranker.rerank(query, candidate_texts, top_n=5)     # meetmind/database/reranker.py
              ├── cohere.ClientV2.rerank(
              │       model="rerank-v4.0-pro",
              │       query=query,
              │       documents=candidate_texts,
              │       top_n=5
              │   )
              ├── 失败兜底：API 报错时直接返回前 top_n 条原序（不让链路断）
              └── 返回 [RerankedDoc(index, relevance_score), ...]   按分数从高到低
        
        → 按 reranked 顺序回组 RetrievedDoc(content, metadata, relevance_score)
        → 取前 top_n=5 返回
  
  → "\n".join(d.as_context_line() for d in docs)   返回格式化字符串给 LLM
```

> **链路上的两个常量**（在 Settings 里可调）：
> - `RETRIEVE_TOP_N=20` —— BM25 / kNN 各自捞这么多候选送 rerank
> - `RERANK_TOP_N=5`    —— Cohere rerank 后给 LLM 的最终上下文条数

---

## 九、路由决策：`route_to_which_agent(state)`

```
route_to_which_agent(state)               # meetmind/graph/route.py
  │   （被所有节点的条件边调用）
  │
  ├── iteration >= max_iterations  → END          # 安全上限（默认15）
  ├── state["done"] == True        → END          # 架构师宣布完成
  ├── state["next_agent"] in AGENT_NAMES → f"{next_agent}_node"
  └── 默认                         → "architect_node"  # 兜底
```

---

## 十、状态定义：`AgentState`

```python
# meetmind/graph/state.py
class AgentState(TypedDict):
    requirement: str                               # 用户输入的需求（整轮不变）
    messages: Annotated[list[MessageTurn], add]    # 用 operator.add reducer，只追加不覆盖
    next_agent: str | None                         # 下一个发言的 agent 名
    done: bool                                     # 架构师是否宣布完成
    iteration: int                                 # 当前迭代轮次

class MessageTurn(TypedDict):
    agent_name: str
    role: str
    message: str
    next_agent: str | None
```

---

## 十一、配置层：`get_settings()`

```
get_settings()                            # meetmind/config/settings.py
  └── Settings()（lru_cache 单例）
        ├── 读 PROJECT_ROOT/.env
        ├── 映射到字段：
        │     LLM             : api_key / base_url / model_name / max_tokens / temperature
        │     种子           : seed_data_path
        │     Elasticsearch  : es_url / es_api_key / es_index_prefix
        │     Embedding      : embedding_model_name
        │     Cohere Rerank  : cohere_api_key / cohere_rerank_model
        │     检索参数       : retrieve_top_n / rerank_top_n
        │     运行时         : log_level / max_iterations
        │
        └── @field_validator 把相对路径锚定到 PROJECT_ROOT
              # 例如 .env 里写 ./data/seed → 解析为 <PROJECT_ROOT>/data/seed
```

---

## 十二、文件与模块索引

| 文件 | 职责 |
|------|------|
| `main.py` | 项目入口，5 行薄壳 |
| `docker-compose.yml` | 本地单节点 Elasticsearch（HTTP, 无鉴权, 开发用） |
| `meetmind/cli/main.py` | CLI 主循环、bootstrap、讨论驱动 |
| `meetmind/config/settings.py` | Pydantic Settings 单例，读 .env |
| `meetmind/config/constants.py` | AGENT_NAMES、角色常量、路由标记正则 |
| `meetmind/agents/base.py` | BaseAgent 抽象类，invoke() + tool_calls 循环 |
| `meetmind/agents/architect.py` | ArchitectAgent（兼入口 + 终止者） |
| `meetmind/agents/backend.py` | BackendAgent |
| `meetmind/agents/frontend.py` | FrontendAgent |
| `meetmind/agents/tester.py` | TesterAgent |
| `meetmind/agents/pm.py` | PMAgent |
| `meetmind/graph/state.py` | AgentState + MessageTurn TypedDict 定义 |
| `meetmind/graph/builder.py` | build_graph()、节点工厂 _create_node() |
| `meetmind/graph/route.py` | route_to_which_agent()，条件边路由逻辑 |
| `meetmind/database/client.py` | get_es_client() / get_agent_index() / count_docs() —— ES 单例 + index 管理 |
| `meetmind/database/embedding.py` | get_embedder_model() / get_embed_model_dim() / embed() / embed_batch() —— sentence-transformers 本地 embedding |
| `meetmind/database/reranker.py` | rerank() —— Cohere `rerank-v4.0-pro` API 封装（含失败降级） |
| `meetmind/database/initializer.py` | build_agents_indices() / load_seeds_to_es(agent) —— 种子数据灌入 ES（幂等，doc_id = md5(content)[:12]） |
| `meetmind/database/loaders.py` | load_file() —— 按后缀分发到各格式 loader |
| `meetmind/database/splitters.py` | split_docs() —— 按文件类型切块 |
| `meetmind/database/rag_retriever.py` | RAGRetriever —— ES BM25 + ES kNN 并行检索 + Cohere rerank |
| `meetmind/utils/formatting.py` | print_agent_info()，rich 控制台美化输出 |
| `meetmind/utils/logger.py` | get_logger() / setup_logging() |
| `data/seed/<agent>/` | 各 agent 的种子文件目录（json / pdf / docx / md / txt） |
| ES index `<es_index_prefix>_<agent>` | ES 中按 agent 命名的 index，存 content + embedding + metadata |

---

## 附：依赖关系一览

```
                     ┌──────────────────────────────────┐
                     │      cli/main.py (CLI 入口)      │
                     └──────────────┬───────────────────┘
                                    │
        ┌───────────────────────────┼────────────────────────────┐
        ▼                           ▼                            ▼
   _bootstrap                build_graph                     _run_one_discussion
        │                           │                            │
        ├── ping_es                 ├── _build_all_agents        └── graph.stream
        ├── get_embedder_model     │     ↓                             │
        ├── build_agents_indices    │     ArchitectAgent(...)          ▼
        │   └── load_seeds_to_es    │     ...PMAgent(...)         _create_node(agent)
        │       ├── load_file       │         │                        │
        │       ├── split_docs      │         ├── RAGRetriever         ▼
        │       ├── get_agent_index │         │   └── get_agent_index  agent.invoke(req, hist)
        │       ├── embed_batch     │         └── ChatOpenAI           │
        │       └── es.bulk         │                                  │
        └── count_docs              │                                  │
                                    └── add_node + add_conditional ─→ │
                                                                      ├── clean_bad_chars
                                                                      ├── bind_tools([rag])
                                                                      ├── tool_calls 循环
                                                                      │     └── rag_tool.invoke
                                                                      │           └── RAGRetriever.retrieve
                                                                      │                 ├── _bm25_search (ES)
                                                                      │                 ├── _knn_search (ES + embed)
                                                                      │                 ├── _merge_unique
                                                                      │                 └── reranker.rerank (Cohere)
                                                                      └── _get_next_agent → AgentResponse
```
