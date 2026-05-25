# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

MeetMind 是一个多 Agent RAG 协作系统的 demo：5 个角色 Agent（架构师、后端、前端、测试、产品经理）围绕一个项目需求展开讨论。架构师作为入口和终止者，其他角色在 LangGraph 条件边的驱动下自由路由。每个 Agent 拥有独立的 ES index + 私有 RAG 工具（ES 混合检索 + Cohere rerank）。

LLM 通过 OpenAI 兼容协议调用（默认配置小米 MiMo），所以 `_model = ChatOpenAI(...)` 里有一个 `extra_body={"thinking": {"type": "disabled"}}` 不能改。

## 常用命令

包管理用 **uv**，不要用 pip。

```bash
# 第一次（或换机）启动:
docker compose up -d                   # 起本地单节点 Elasticsearch (localhost:9200)
uv sync                                # 安装 / 更新依赖（含 torch，~1GB）
uv run python main.py                  # 启动 CLI
uv run meetmind                        # 同上（console script）

# 重置某个 agent 的 ES index 并重灌（开发时常用）
uv run python -c "from meetmind.database import reset_agent_db; reset_agent_db('backend')"

# 完全抹库后重灌（删 docker volume，下次启动重新建 index + 灌种子）
docker compose down -v && docker compose up -d
```

环境变量在 `.env`（参考 `.env.example`）：`API_KEY` / `BASE_URL` / `MODEL_NAME` / `COHERE_API_KEY` 缺一不可，启动时会校验并 `sys.exit(1)`。`ES_URL` 默认 `http://localhost:9200`，连不上也会 `sys.exit(1)`。

## 高层架构

### 调用链一句话

```
main.py → cli.main.main() → [_print_banner / _bootstrap / build_agent_graph / while True]
                                              ↓
                            graph.stream() → _node(state) → agent.invoke() → tool_calls 循环
                                              ↓
                                       route_next(state) → 下一个 _node 或 END
```

### 三层职责分离

1. **`meetmind/agents/`** — 角色定义。`BaseAgent.invoke()` 是核心，做三件事：(1) 用 `clean_bad_chars` 清掉 stdin 来的 surrogate 码点；(2) 把 RAG 检索器作为 LangChain Tool 绑定到 LLM，跑最多 `_MAX_TOOL_ITERATIONS=5` 轮的 tool_calls 循环；(3) 调 `_get_next_node` 从 LLM 回复里解析 `[NEXT_AGENT: xxx]` 或 `[DONE]` 标记。

2. **`meetmind/graph/`** — LangGraph 编排。`AgentState` 是共享状态（`messages` 用 `operator.add` reducer 追加、其他字段覆盖）；`route_next` 是所有节点共用的条件边函数，按 `iteration >= max_iterations` → `state["done"]` → `state["next_agent"] in AGENT_NAMES` → `architect_node` 兜底的顺序决定下一节点。

3. **`meetmind/database/`** — RAG，**全部走 ES + Cohere**。`client.py` 负责 ES 单例 + 每 agent 的 index（mapping 同时含 `content: text`、`embedding: dense_vector`、`metadata.*: keyword`）；`embedding.py` 用 sentence-transformers `all-MiniLM-L6-v2` 本地算 384 维向量；`initializer._populate_one_agent` 跑「load → split → embed → ES bulk index」灌库，用内容 md5 作为 `_id` 实现幂等；`rag_retriever.RAGRetriever.retrieve(query)` 是核心：**并行跑 BM25 检索 + kNN 向量检索 → 按 `_id` 去重合并 → 全部送 `reranker.rerank()` 调 Cohere `rerank-v4.0-pro` → 按 relevance_score 排序返回 top-K**。候选数和返回数分别由 `RETRIEVE_TOP_N=20` 和 `RERANK_TOP_N=5` 控制。

### 关键设计点

- **路由协议是字符串约定**：Agent 在回复末尾写 `[NEXT_AGENT: name]` 或 `[DONE]`，`_get_next_node` 用正则解析。非架构师如果意外输出 `[DONE]` 也会被同等处理；解析失败时兜底回 architect，保证图永远不卡死。
- **RAG 是 Tool 不是 prompt 注入**：旧版本在 prompt 里塞检索结果，现在改为 `bind_tools([rag_tool])` 让 LLM 自主决定是否调用。代价是模型必须支持 OpenAI function calling 协议。
- **路径相对性**：`config/settings.py` 里有一个 `@field_validator` 把 `.env` 里 `SEED_DATA_PATH=./data/seed` 这类相对路径自动锚定到 `PROJECT_ROOT`。不要去掉这个 validator，否则从 IDE / 不同 cwd 启动会找不到种子目录。
- **首次启动 ~80MB + ~1GB**：sentence-transformers 首次 `SentenceTransformer(...)` 调用会从 HuggingFace 下载 ~80MB 权重到 `~/.cache/huggingface/`；同时 `uv sync` 装的 torch 本身约 800MB。两个都是一次性。
- **种子目录结构**：`data/seed/<agent>/*.{json,pdf,docx,md,txt}` —— 把任意支持的文件丢进对应 agent 子目录即可。`loaders.py` 按后缀分发，`splitters.py` 再按 `type` 字段二次切块。重灌某 agent 用 `reset_agent_db('xxx')`；抹整库用 `docker compose down -v`。
- **ES 是硬依赖**：CLI 启动会 `ping_es()`，挂了直接 `sys.exit(1)`。本地默认走 `docker-compose.yml` 起的单节点 ES（关 TLS + 鉴权，方便开发）。生产应该走 `ES_URL` + `ES_API_KEY`。

## 这个仓库的命名习惯（重要：不要"修正"）

仓库主人保留了一些**违反 PEP 8 但有意为之**的命名，遇到时请遵循，不要自动重命名：

| 项 | 当前命名 | 备注 |
|---|---|---|
| `BaseAgent` 实例上的 RAG 引用 | `self.RAGRetriever` | 不是 `self.rag_retriever`，刻意大驼峰 |
| BaseAgent prompt 拼装 | `_user_prompt(requirement, history)` / `_routing_prompt()` | 不是 `_build_user_prompt` / `_routing_instructions`，已去掉冗余前缀 |
| BaseAgent 主方法 | `invoke(requirement, conversation_history)` | 不是 `process()` |
| 路由解析 | `_get_next_node(text)` | 不是 `_parse_routing()` |
| 字符清理 | `clean_bad_chars(text)` | 模块级函数；不是 `_scrub_surrogates()` |
| RAG 工具 | `RAGRetriever.restart()` / `.to_tool()` | 不是 `reset_tracking()` / `as_langchain_tool()`；ES 版本已不需要 `mark_dirty()` |
| Initializer 私函数 | `_populate_one_agent` / `_get_seeds_content` / `_generate_doc_id` | 不是 `_seed_agent` / `_load_agent_seeds` / `_doc_id` |
| Initializer 入口 | `build_agents_indices()` | 不是 `build_agents_collections()`（ES 时代叫 index 不叫 collection） |
| ES 客户端 / index | `get_es_client()` / `ensure_agent_index(agent)` / `count_docs(agent)` | 不是 `get_agent_client` / `get_agent_collection` |
| CLI 复盘 | `_next_round_or_not(state)` | 不是 `_architect_review()` |
| CLI 输出 | `print_agent_info()` | 不是 `format_agent_output()` |
| State 完成字段 | `AgentState["done"]` | 不是 `complete` |
| Agent 响应字段 | `AgentResponse.next_agent` | 不是 `output_role`（但 `MessageTurn.output_role` 保留，那是消息记录） |

写注释优先用中文，符合现有风格。

## 容易踩的坑

- 改 `cli/main.py` 的 stdin/stdout reconfigure 块时小心：那段是为了在非 UTF-8 locale 终端下避免中文输入产生 `\udcXX` surrogate 导致 httpx 编码崩溃。`BaseAgent.invoke` 里的 `clean_bad_chars` 是第二道防线，两者都要保留。
- ES 灌库后**无需通知 RAGRetriever**：所有检索都直接查 ES，无内存索引。但 Cohere rerank 是有调用成本的 API，retrieve 失败时 reranker 内部会自动降级为"原序返回前 N 条"（见 `reranker.rerank` 的 except 分支），不会让链路完全断。
- ES mapping 用 `standard` 分词器对中文按字符切（一字一 token），召回精度比 jieba 差。**但因为后面有 Cohere rerank 兜底**，BM25 召回粗一点没关系——rerank 会把不相关的过滤掉。如果将来想要精细的中文 BM25，可以装 IK 分词器插件改 mapping 的 `analyzer`。
- `sentence-transformers` 5.x 把 `get_sentence_embedding_dimension` 改名为 `get_embedding_dimension`。`embedding._read_dim` 做了兼容（两种 API 都试），未来如果升级 ST 版本删旧 API，把这个 try 拆掉即可。
- LangGraph 节点函数的返回值 dict 会按字段并入 State：`messages` 走 `operator.add` reducer 追加，其他字段覆盖。在 `_node` 里只 return 增量更新即可。
- ES index 名约定 `<es_index_prefix>_<agent_name>`（默认 `meetmind_architect` 等）。换前缀要同时考虑：`ES_INDEX_PREFIX` 改 → 旧 index 不会自动迁移，得手动 reindex 或者 `docker compose down -v` 重灌。

## 编码风格

**核心原则：代码首先是写给人看的，不是给机器优化的。** 任何陌生人第一次读代码，不应该需要反向推导才能明白每一行在做什么。

具体禁止的写法：

- **禁止三元表达式**（`x if cond else y`）：用 `if/else` 块展开，每个分支单独一行；
- **禁止推导式**（列表 / 字典 / 集合 / 生成器推导式）：用显式 `for` 循环 + `append` / 赋值替代；
- **禁止多层链式调用**（`a.b().c()` 或 `fn1(fn2(x))`）：把每一步的结果赋给一个有名字的中间变量，再传给下一步；
- **中间结果必须命名**：每一步计算产生的值，用一个见名知意的变量名存起来，不要直接嵌入下一层调用。

例外：以下场景不受此限制——

- `str.join()` 的直接用法（`"\n".join(lines)`），前提是 `lines` 已经是具名变量；
- `logger.info(...)` 等日志调用内部的简单格式化；
- 两层以内、语义一目了然的属性访问（`settings.chroma_base_path`）。

## 项目入口

`main.py`（项目根）是 5 行的薄壳，真正的 CLI 在 `meetmind/cli/main.py:main()`。
