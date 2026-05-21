# MeetMind — 多 Agent RAG 协作系统

基于 **LangChain + LangGraph + Chroma** 的多角色 Agent 协作 Demo。
模拟一个研发项目组：架构师、后端、前端、测试、产品经理 5 个 Agent，每个 Agent 拥有：

- 自己的 **Chroma 本地 RAG 数据库**（独立目录，存储工作日志/代码片段/文档）；
- 一个 **RAG 检索 Tool**（langchain `Tool`）；
- 独立的 **System Prompt** 和 LangGraph 节点；
- 通过 **`output_role` 字段** 决定下一个发言 Agent（自由路由 / `conditional_edges`）。

LLM 接入采用 **OpenAI 兼容协议** (`langchain_openai.ChatOpenAI`)，默认面向小米 MiMo。

---

## 项目结构

```text
MeetMind/
├── pyproject.toml                    # Hatch 构建配置 + 依赖声明 + console script (`meetmind`)
├── main.py                           # 根入口；`uv run python main.py` 从这里启动，转调 cli.main:main
├── .env.example                      # 环境变量模板（API_KEY/BASE_URL/MODEL_NAME …）；复制为 .env 后填写
├── .env                              # 真实运行配置（git-ignored，不会被提交）
├── .gitignore                        # 忽略 .venv / __pycache__ / chroma_data / .env / IDE 配置
├── README.md                         # 本文档
├── uv.lock                           # uv 锁定文件，确保所有人装出同样依赖版本
│
├── meetmind/                         # ★ 主包（flat layout，IDE 可直接解析 `from meetmind...`）
│   ├── __init__.py                   # 暴露包级常量 `__version__`
│   │
│   ├── agents/                       # ── 智能体层（5 个角色 + 1 个基类） ──────────
│   │   ├── __init__.py               # 统一导出 BaseAgent / AgentResponse / 5 个具体 Agent
│   │   ├── base.py                   # BaseAgent 抽象类：调 LLM、查 RAG、解析 [NEXT_AGENT]、清洗 UTF-8 surrogate
│   │   ├── architect.py              # 架构师 Agent —— 接收需求、分派任务、判断并宣布 [DONE]
│   │   ├── backend.py                # 后端工程师 Agent —— API 接口 / 数据模型 / 性能 / 安全
│   │   ├── frontend.py               # 前端工程师 Agent —— 页面结构 / 组件 / 交互 / UI 一致性
│   │   ├── tester.py                 # 测试工程师 Agent —— 用例设计 / 风险评估 / 自动化建议
│   │   └── pm.py                     # 产品经理 Agent —— 用户故事 / 验收标准 / 优先级
│   │
│   ├── tools/                        # ── 工具层（每个 Agent 拥有的能力） ──────────
│   │   ├── __init__.py               # 导出 RAGRetriever
│   │   └── rag_retriever.py          # 包装 Chroma collection：retrieve / add_documents / as_langchain_tool
│   │
│   ├── database/                     # ── 数据库层（每个 Agent 独立 Chroma DB） ────
│   │   ├── __init__.py               # 导出 get_agent_collection / initialize_all_agents / reset_agent_db
│   │   ├── constants.py              # 集合命名约定：`{agent_name}_knowledge`
│   │   ├── client.py                 # `PersistentClient` 工厂；按 agent 缓存，定向到独立目录
│   │   └── initializer.py            # 启动时把 data/seed/*.json 灌入对应 collection；支持单 agent 重置
│   │
│   ├── graph/                        # ── LangGraph 编排层（多 Agent 状态机） ─────
│   │   ├── __init__.py               # 导出 AgentState / MessageTurn / build_agent_graph
│   │   ├── state.py                  # `AgentState` TypedDict —— messages 用 `operator.add` 追加式聚合
│   │   ├── routing.py                # `route_next()` 条件边：next_agent → 对应节点；complete/超限 → END
│   │   └── builder.py                # 装配并 compile StateGraph：每个 Agent 包装为 node + 实时 Rich 打印
│   │
│   ├── config/                       # ── 配置层 ───────────────────────────────────
│   │   ├── __init__.py               # 导出 Settings / get_settings / 角色常量
│   │   ├── constants.py              # AGENT_NAMES、ARCHITECT…枚举；`[NEXT_AGENT: …]` / `[DONE]` 正则与标记
│   │   └── settings.py               # `Settings(BaseSettings)`：读 .env，含 api_key/base_url/路径/limits
│   │
│   ├── utils/                        # ── 通用工具 ─────────────────────────────────
│   │   ├── __init__.py               # 导出 get_logger / setup_logging / format_agent_output / format_separator
│   │   ├── logger.py                 # 基于 RichHandler 的日志配置；保留 chromadb INFO 以显示首次下载进度
│   │   └── formatting.py             # Rich Panel 渲染 agent 输出（颜色、RAG 来源、下一跳）+ 通用分隔符
│   │
│   └── cli/                          # ── 交互式命令行入口 ─────────────────────────
│       ├── __init__.py               # 包占位
│       └── main.py                   # banner → bootstrap(强制 UTF-8 + 初始化) → 主循环 → 架构师复盘
│
├── data/
│   └── seed/                         # ── RAG 种子文档（启动时一次性灌入 Chroma） ──
│       ├── architect_seeds.json      # 架构决策 / 技术选型 / 协作规范 / 架构约束 / 技术债 6 条
│       ├── backend_seeds.json        # 项目结构 / 认证实现 / 连接池 / 性能最佳实践 / 响应封装 6 条
│       ├── frontend_seeds.json       # 技术栈 / 目录结构 / 认证页 / UI 规范 / 性能优化 6 条
│       ├── tester_seeds.json         # 测试体系 / 用例样本 / 线上故障复盘 / 通用清单 6 条
│       └── pm_seeds.json             # 产品定位 / 用户画像 / Q2 目标 / 评审规范 / 竞品 6 条
│
├── chroma_data/                      # ★ 本地 RAG 持久化（运行时生成，git-ignored）
│   │                                 #   嵌入式 SQLite + 向量索引；不依赖任何 Docker / 服务进程
│   ├── architect/                    #   架构师私有知识库（chroma.sqlite3 + 向量段文件）
│   ├── backend/                      #   后端工程师私有知识库
│   ├── frontend/                     #   前端工程师私有知识库
│   ├── tester/                       #   测试工程师私有知识库
│   └── pm/                           #   产品经理私有知识库
│
└── tests/
    └── __init__.py                   # 测试目录占位（pytest 用例待补）
```

> 备注：
> - `chroma_data/` 第一次运行才会出现；删除整个目录后下次启动会自动从 `data/seed/*.json` 重建。
> - Embedding 模型缓存在用户家目录的 `~/.cache/chroma/`，不在项目内。
> - `__init__.py` 在每个包内做"统一对外导出"，把内部实现解耦于调用方。

---

## 快速开始（使用 [uv](https://github.com/astral-sh/uv)）

### 1. 同步依赖

```bash
cd /Users/chenlv/Project/MeetMind
uv sync
```

`uv sync` 会读取 `pyproject.toml`，创建 `.venv/`，并以 editable 模式安装 `meetmind` 自身——之后 `from meetmind...` 在 PyCharm / VS Code 中均可直接解析。

> **首次启动会下载 embedding 模型（约 80MB）**
> Chroma 默认使用本地 ONNX `all-MiniLM-L6-v2` 进行向量化，首次会从
> `https://chroma-onnx-models.s3.amazonaws.com/` 拉取到 `~/.cache/chroma/`，约 1–2 分钟。
> 此后 RAG 完全在本地运行（嵌入式 SQLite，不依赖任何 Docker 容器），启动只需几秒。
> RAG 数据持久化在项目根目录的 `chroma_data/`（与 `data/`、`tests/` 同级）。

### 2. 配置 LLM

```bash
cp .env.example .env
# 编辑 .env：
#   API_KEY=<你的 key>
#   BASE_URL=https://...        # 例如小米 MiMo 提供的 OpenAI 兼容端点
#   MODEL_NAME=<模型名>
```

### 3. 运行

```bash
uv run python main.py
```

或者通过安装好的 console script：

```bash
uv run meetmind
```

---

## 运行流程

1. **启动时**：自动为 5 个 Agent 初始化各自的 Chroma DB 并灌入 `data/seed/*_seeds.json` 的种子数据。
2. **架构师输入需求** → 进入 LangGraph 流程。
3. **每个 Agent 节点**:
   - 用需求查询自己的 RAG；
   - 调用 LLM 生成回复（`ChatOpenAI` + `extra_body={"thinking": {"type": "disabled"}}`）；
   - 在回复末尾标注 `[NEXT_AGENT: <name>]` 或 `[DONE]`；
   - 状态写入 `next_agent` 字段。
4. **条件边路由 (`route_next`)**: 根据 `next_agent` 路由到对应节点；架构师宣布 `[DONE]` 或达到 `max_iterations` 则结束。
5. **架构师复盘**：CLI 提示是否继续新一轮或退出。

---

## 关键技术决策

| 设计 | 理由 |
|------|------|
| `Annotated[list, add]` 追加式 messages | 保留完整讨论历史，符合 LangGraph 语义 |
| 每个 Agent 独立 `PersistentClient` | 数据隔离，可单独 reset |
| `[NEXT_AGENT: name]` 字符串协议 | 比 JSON 解析更鲁棒，LLM 失败时易回退 |
| `route_next` 单一路由函数 | 所有节点共用同一条件边逻辑，结构简洁 |
| 架构师 = human-in-the-loop | 每轮结束由人工决定继续/退出 |
| `max_iterations` 安全阀 | 防止 Agent 间无限循环 |
| OpenAI 兼容 + `extra_body` 透传 | 兼容主流国产/开源大模型 (MiMo / DeepSeek / Qwen 等) |

---

## 常用操作

**重置某个 Agent 的 RAG 数据库**：

```bash
uv run python -c "from meetmind.database import reset_agent_db; reset_agent_db('backend')"
```

**修改默认模型 / 温度 / RAG top-k**：编辑 `.env` 中的 `MODEL_NAME`、`TEMPERATURE`、`RAG_TOP_K`。

**修改各 Agent 的 system prompt**：编辑 `meetmind/agents/{role}.py`。

**增加新 Agent**：

1. 在 `meetmind/config/constants.py` 中加入名称；
2. 复制一份 agent 类并实现 `system_prompt`；
3. 在 `meetmind/graph/builder.py` 的 `_build_agents()` 注册；
4. 增加 `data/seed/<name>_seeds.json`。

**切换 LLM 提供商**：只要对方提供 OpenAI 兼容端点，改 `.env` 中的 `BASE_URL` 与 `MODEL_NAME` 即可。若新提供商不支持 `extra_body.thinking`，可在 `meetmind/agents/base.py` 中删除该参数。

---

## 依赖

- Python ≥ 3.10
- `langchain`, `langchain-core`, `langchain-openai`
- `langgraph`
- `chromadb`
- `pydantic`, `pydantic-settings`, `python-dotenv`
- `rich`（CLI 美化）

完整依赖见 [`pyproject.toml`](./pyproject.toml)。
