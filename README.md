# MeetMind — 多 Agent RAG 协作系统

基于 **LangChain + LangGraph + Elasticsearch + Cohere Rerank** 的多角色 Agent 协作 Demo。
模拟一个研发项目组：架构师、后端、前端、测试、产品经理 5 个 Agent，每个 Agent 拥有：

- 一个 **独立的 Elasticsearch index**（存储 + BM25 关键词检索 + dense_vector 向量检索 三合一）；
- 一个 **RAG 检索 Tool**（LangChain `Tool`），底层执行 **混合检索 + Cohere Rerank**；
- 独立的 **System Prompt** 和 LangGraph 节点；
- 通过 **`next_agent` 字段** 决定下一个发言 Agent（自由路由 / `conditional_edges`）。

LLM 接入采用 **OpenAI 兼容协议** (`langchain_openai.ChatOpenAI`)，默认面向小米 MiMo。

---

## RAG 检索链路

```
用户 query
   │
   ├──► ES BM25 检索 → top_20 候选 ─┐
   │                                ├──► 合并去重 ──► Cohere Rerank (rerank-v4.0-pro)
   ├──► sentence-transformers       │                     │
   │    → query embedding           │                     ▼
   └──► ES kNN 向量检索 → top_20 ───┘            最终 top_5 给 LLM
```

- **存储 + 检索**：单一 Elasticsearch 实例承担"文档存储 + 倒排索引（BM25） + 向量索引（dense_vector kNN）"三件事。
- **Embedding**：本地 `sentence-transformers/all-MiniLM-L6-v2`（384 维），首次启动会下载约 80MB 到 `~/.cache/huggingface/`。
- **Rerank**：候选送 Cohere `https://api.cohere.com/v2/rerank` 的 `rerank-v4.0-pro` 模型重排，最终 top_n 给 LLM。

---

## 项目结构

```text
MeetMind/
├── pyproject.toml                    # 依赖声明 + console script (`meetmind`)
├── docker-compose.yml                # 本地单节点 Elasticsearch（HTTP, 无鉴权, 开发用）
├── main.py                           # 根入口；转调 cli.main:main
├── .env.example                      # 环境变量模板；复制为 .env 后填写
├── .env                              # 真实运行配置（git-ignored）
├── README.md / CLAUDE.md
│
├── meetmind/                         # ★ 主包（flat layout）
│   ├── agents/                       # BaseAgent + 5 个角色 Agent
│   │   ├── base.py                   # 抽象基类：LLM 调用 + tool_calls 循环 + 路由解析
│   │   ├── architect.py / backend.py / frontend.py / tester.py / pm.py
│   │
│   ├── database/                     # ★ ES 存储 + 混合检索 + Cohere rerank
│   │   ├── client.py                 # ES 单例 + index 管理（建带 dense_vector mapping）
│   │   ├── embedding.py              # sentence-transformers wrapper (单例 + lru_cache)
│   │   ├── reranker.py               # Cohere v2 rerank API 封装
│   │   ├── loaders.py                # 文件解析：JSON / MD / PDF / DOCX / TXT 五种 loader
│   │   ├── splitters.py              # 按文件类型选 splitter 切块
│   │   ├── initializer.py            # 灌库流程：load → split → embed → ES bulk index
│   │   ├── rag_retriever.py          # ★ BM25 + kNN 并行检索 → 合并去重 → Cohere rerank
│   │   └── constants.py              # index 名约定：`<prefix>_<agent>`
│   │
│   ├── graph/                        # LangGraph 编排
│   │   ├── state.py                  # AgentState (TypedDict)：messages 追加 / 其余覆盖
│   │   ├── routing.py                # route_next 条件边
│   │   └── builder.py                # 装配 + compile StateGraph
│   │
│   ├── config/                       # Settings (pydantic-settings) + 常量
│   ├── utils/                        # logger / formatting
│   └── cli/main.py                   # 交互式 CLI：banner → bootstrap → 主循环
│
├── data/seed/<agent>/                # ★ RAG 种子文档（输入）
│   └── *.{json,pdf,docx,md,txt}      # 任意支持的格式，loader 按后缀分发
│
└── tests/
```

> 备注：
> - ES 数据存在 docker volume `meetmind_es_data` 里（不在项目目录内）；删卷 `docker compose down -v` 会触发下次启动重灌种子。
> - sentence-transformers 模型缓存在 `~/.cache/huggingface/`，不在项目内。

---

## 快速开始（使用 [uv](https://github.com/astral-sh/uv)）

### 1. 同步依赖

```bash
cd /Users/chenlv/Project/MeetMind
uv sync
```

依赖包括 `elasticsearch` / `sentence-transformers`（带 torch，约 1GB）/ `cohere`。

### 2. 启动 Elasticsearch

```bash
docker compose up -d
# 验证: curl http://localhost:9200
```

`docker-compose.yml` 起一个单节点 ES 8.15，关闭 TLS + 鉴权，便于本地开发。

### 3. 配置 .env

```bash
cp .env.example .env
# 必填:
#   API_KEY / BASE_URL / MODEL_NAME      ← LLM (OpenAI 兼容端点)
#   COHERE_API_KEY                       ← Cohere rerank
# 可选默认:
#   ES_URL=http://localhost:9200
#   EMBEDDING_MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2
#   RETRIEVE_TOP_N=20   RERANK_TOP_N=5
```

### 4. 运行

```bash
uv run python main.py
# 或:
uv run meetmind
```

启动时会：
- ping ES（挂了直接退）
- 校验 Cohere key
- 扫描 `data/seed/<agent>/` 列出所有种子文件
- 加载 embedding 模型（首次 ~80MB）
- 灌库到 ES（幂等，已存在的 doc_id 跳过）

---

## 运行流程

1. **启动时**：所有 agent 的种子文件灌入对应 ES index（content + embedding + metadata）。
2. **架构师输入需求** → 进入 LangGraph 流程。
3. **每个 Agent 节点**:
   - 把私有 RAG 检索器作为 LangChain Tool 绑定到 LLM；
   - LLM 自主决定是否调用 `rag_search_<agent>`；调用时执行 ES hybrid + Cohere rerank；
   - LLM 在回复末尾标注 `[NEXT_AGENT: <name>]` 或 `[DONE]`。
4. **条件边路由 (`route_next`)**: `iteration ≥ max → END`；`done → END`；`next_agent ∈ AGENT_NAMES → 对应节点`；兜底回 architect。
5. **架构师复盘**：CLI 提示是否继续新一轮或退出。

---

## 关键技术决策

| 设计 | 理由 |
|------|------|
| Elasticsearch 三合一（存储 + BM25 + 向量） | 不再维护 Chroma + 外部 BM25 索引两套；ES 8.x 原生支持 dense_vector kNN |
| `sentence-transformers` 本地 embedding | 不依赖外部 API；和原 chroma 内置 ONNX MiniLM 同一模型，迁移无缝 |
| Cohere `rerank-v4.0-pro` 重排 | 混合检索召回宽，rerank 精确收敛；外部 API 调用，质量明显高于自己写融合 |
| 候选 `top_20` → 重排 `top_5` | 召回阶段宁多勿少；rerank 阶段宁精勿滥，留 5 条给 LLM 控住上下文长度 |
| `Annotated[list, add]` 追加式 messages | 保留完整讨论历史，符合 LangGraph 语义 |
| `[NEXT_AGENT: name]` 字符串协议 | 比 JSON 解析更鲁棒，LLM 失败时易回退 |
| 架构师 = human-in-the-loop | 每轮结束由人工决定继续/退出 |
| `max_iterations` 安全阀 | 防止 Agent 间无限循环 |

---

## 常用操作

**重置某个 Agent 的 ES index**：

```bash
uv run python -c "from meetmind.database import reset_agent_db; reset_agent_db('backend')"
```

**完全清空 + 重灌**：

```bash
docker compose down -v && docker compose up -d
uv run python main.py    # 启动时会自动重灌
```

**修改混合检索 / rerank 参数**：编辑 `.env` 中的 `RETRIEVE_TOP_N`、`RERANK_TOP_N`。

**增加新 Agent**：

1. `meetmind/config/constants.py` 加入名字；
2. 复制一个 agent 类实现 `system_prompt`；
3. `meetmind/graph/builder.py` 的 `_build_all_agents()` 注册；
4. 在 `data/seed/<name>/` 放种子文件。

**切换 LLM 提供商**：只要提供 OpenAI 兼容端点，改 `.env` 中的 `BASE_URL` 与 `MODEL_NAME` 即可。若新提供商不支持 `extra_body.thinking`，可在 `meetmind/agents/base.py` 中删除该参数。

---

## 依赖

- Python ≥ 3.10
- `langchain`, `langchain-core`, `langchain-openai`, `langgraph`
- `elasticsearch` (8.x)
- `sentence-transformers`（自带 torch）
- `cohere`
- `pypdf`, `python-docx`, `langchain-text-splitters`（文档加载 + 切块）
- `pydantic`, `pydantic-settings`, `python-dotenv`
- `rich`（CLI 美化）

完整依赖见 [`pyproject.toml`](./pyproject.toml)。
