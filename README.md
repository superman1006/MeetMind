<div align="center">

<img src="assets/banner.png" alt="MeetMind"/>

### 多 Agent RAG 协作系统 · Multi-Agent RAG Collaboration

**简体中文** ｜ [English](README.en.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![LangGraph](https://img.shields.io/badge/LangChain%20%2F%20LangGraph-1C3C3C?style=flat-square&logo=langchain&logoColor=white)](https://langchain-ai.github.io/langgraphjs/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![pgvector](https://img.shields.io/badge/pgvector-008BB9?style=flat-square)](https://github.com/pgvector/pgvector)
[![Transformers.js](https://img.shields.io/badge/Transformers.js-FFD21E?style=flat-square&logo=huggingface&logoColor=black)](https://huggingface.co/docs/transformers.js)

[![Quick Start](https://img.shields.io/badge/🚀_Quick_Start-00C853?style=for-the-badge&logoColor=white)](#快速开始)
[![License MIT](https://img.shields.io/badge/License-MIT-555555?style=for-the-badge)](LICENSE)
<br/>
[![Claude Code](https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://claude.com/claude-code)
[![Codex](https://img.shields.io/badge/Codex-000000?style=for-the-badge&logo=openai&logoColor=white)](https://openai.com/codex/)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-4285F4?style=for-the-badge&logo=googlegemini&logoColor=white)](https://github.com/google-gemini/gemini-cli)
[![Cursor](https://img.shields.io/badge/Cursor-000000?style=for-the-badge&logo=cursor&logoColor=white)](https://cursor.com/)
[![Trae](https://img.shields.io/badge/Trae-FF3B30?style=for-the-badge&logoColor=white)](https://trae.ai/)

> 本项目可配合 **Claude Code / Codex / Gemini CLI / Cursor / Trae** 等 AI 编程助手进行二次开发与协作。

</div>

---

基于 **LangChain + LangGraph + PostgreSQL（pgvector）+ 本地 cross-encoder Rerank** 的多角色 Agent 协作 Demo（TypeScript 实现）。
模拟一个研发项目组：架构师、后端、前端、测试、产品经理 5 个 Agent，每个 Agent 拥有：

- 一张 **独立的 PostgreSQL 表**（存储 + pg_trgm 关键字召回 + pgvector 向量检索 三合一）；
- 一个 **RAG 检索 Tool**（LangChain `Tool`），底层执行 **混合检索 + 本地 rerank**；
- 独立的 **System Prompt** 和 LangGraph 节点；
- 通过结构化输出的 **`next_agent` 字段** 决定下一个发言 Agent（自由路由 / `conditionalEdges`）。

LLM 接入采用 **OpenAI 兼容协议** (`@langchain/openai` 的 `ChatOpenAI`)，默认面向小米 MiMo。

---

## RAG 检索链路

```
用户 query
   │
   ├──► pg_trgm 关键字召回 → top_20 候选 ─┐
   │                                      ├──► 合并去重 ──► 本地 cross-encoder Rerank
   ├──► transformers.js                   │                (Xenova/bge-reranker-base)
   │    → query embedding                 │                     │
   └──► pgvector kNN 向量检索 → top_20 ───┘                     ▼
                                                       最终 top_5 给 LLM
```

- **存储 + 检索**：单一 PostgreSQL（pgvector）实例承担"文档存储（表）+ 关键字召回（pg_trgm word_similarity） + 向量索引（pgvector cosine kNN）"三件事。
- **Embedding**：本地 `@huggingface/transformers`（Transformers.js）跑 `all-MiniLM-L6-v2`（384 维），首次启动下载约 80MB 到 `./models/`。
- **Rerank**：候选送**本地 cross-encoder**（默认 `Xenova/bge-reranker-base`，同样走 `@huggingface/transformers`）逐条算 query↔候选 相关性分，sigmoid 归一化后取 top_n 给 LLM。**无需联网、无需 API key**；失败时降级为返回前 N 条原序。

---

## 项目结构

这是一个 **pnpm monorepo**，两个 app：

```text
MeetMind/
├── package.json                     # 根 workspace：dev / dev:runtime / dev:desktop / typecheck / build / test
├── pnpm-workspace.yaml              # workspace 声明（apps/*）
├── pnpm-lock.yaml                   # 锁文件（包管理用 pnpm）
├── tsconfig.base.json               # 共享 TS 配置
├── docker-compose.yml               # 本地单节点 PostgreSQL+pgvector（pgvector/pgvector:pg17, 宿主机 5433）
├── .env.example / .env              # 环境变量模板 / 真实运行配置（.env 在根，两个 app 共享）
├── README.md / project_flow.md / CLAUDE.md
├── models/                          # embedding / rerank 模型本地缓存（git-ignored，两个 app 共享）
├── data/
│   ├── seed/<agent>/                # ★ RAG 种子文档（输入）*.{json,pdf,docx,md,txt}
│   └── summary/<sessionId>.md       # 会议结束整理出的纪要
│
└── apps/
    ├── runtime/                     # ★ 后端：多 Agent 讨论 + RAG + 持久化 + HTTP/SSE 服务(3002)
    │   ├── src/  (agents / graph / database / tools / server / config / utils / cli)
    │   └── README.md                # → 后端详细说明
    └── desktop/                     # ★ 前端：Vue 3 + Vite + Tauri 2 桌面外壳
        ├── src/  (api / stores / components / theme)
        ├── src-tauri/               # Tauri 原生外壳（Rust）
        └── README.md                # → 前端详细说明
```

- **后端 [`apps/runtime/README.md`](apps/runtime/README.md)** —— 引擎 + 工具层（RAG / 命令行 / 文件 / MCP 联网搜索）+ PostgreSQL 持久化 + HTTP/SSE 服务。
- **前端 [`apps/desktop/README.md`](apps/desktop/README.md)** —— 聊天式界面、流式讨论、工具调用按钮 + 结果面板。
- **逐函数调用链 [`project_flow.md`](project_flow.md)** —— runtime 的完整调用链 + SSE 事件契约。

> 备注：
> - PostgreSQL 数据存在 docker volume `meetmind_pg_data` 里（不在项目目录内）；删卷 `docker compose down -v` 会触发下次启动重灌种子。
> - embedding 与 rerank 模型都缓存在项目内 `./models/`（由 `EMBEDDING_CACHE_DIR` 控制），首次启动各下载一次。

---

## 快速开始

### 1. 安装依赖

```bash
cd /Users/chenlv/Project/MeetMind
pnpm install
```

依赖包括 `pg`（PostgreSQL 客户端）/ `@huggingface/transformers`（embedding + rerank，本地推理）/ `@langchain/*`。

### 2. 启动 PostgreSQL（含 pgvector）

```bash
docker compose up -d
# 验证: docker exec meetmind-pg pg_isready -U meetmind
#       或 psql postgresql://meetmind:meetmind@localhost:5433/meetmind
```

`docker-compose.yml` 起一个单节点 `pgvector/pgvector:pg17`（用户/库/密码都是 `meetmind`），**宿主机端口映射到 5433**（避让本机原生 postgres 常占用的 5432）。镜像自带 `vector` 扩展，启动后 app 会自动 `CREATE EXTENSION vector / pg_trgm`。

### 3. 配置 .env

```bash
cp .env.example .env
# 必填:
#   API_KEY / BASE_URL / MODEL_NAME      ← LLM (OpenAI 兼容端点)
# 可选默认:
#   PG_URL=postgresql://meetmind:meetmind@localhost:5433/meetmind
#   PG_TABLE_PREFIX=meetmind
#   EMBEDDING_MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2
#   RERANK_MODEL_NAME=Xenova/bge-reranker-base   RERANK_DTYPE=q8   ← 本地 rerank（无需 key）
#   RETRIEVE_TOP_N=20   RERANK_TOP_N=5
```

### 4. 运行

```bash
pnpm dev
# 或构建后跑:
pnpm build && pnpm start:prod
```

启动时会：
- ping PostgreSQL（`SELECT 1`，挂了直接退）
- 打印本地 rerank 模型信息（不再需要 Cohere key）
- 扫描 `data/seed/<agent>/` 列出所有种子文件
- 加载 embedding 模型（首次 ~80MB）
- 灌库到 PostgreSQL（建表 + 建扩展/索引；`ON CONFLICT` 幂等，已存在的 id 跳过）

> 首次触发 rerank（某个 Agent 第一次调 RAG 工具）时会再下载一次 rerank 模型（默认 q8 量化 ~280MB）。

---

## Monorepo 启动（runtime + desktop）

前置：`docker compose up -d` 起 PostgreSQL；首次 `pnpm install`。

- 同时起前后端：`pnpm dev`
- 只起后端服务（3002）：`pnpm dev:runtime`
- 只起前端（5173，浏览器联调）：`pnpm dev:desktop`
- 旧 CLI（保留，不再是默认入口）：`pnpm dev:cli`
- 桌面外壳（需先装 Rust）：`pnpm --filter @meetmind/desktop tauri dev`

后端 3002 暴露 `POST /api`（JSON-RPC）与 `GET /events?sessionId=…`（SSE）：

- **JSON-RPC method**：`chat.send`（开一轮讨论，后台跑、立即返回，过程走 SSE）、`chat.interrupt`（打断本轮，abort 后丢弃不落库）、`chat.end`（结束会议→整理纪要写 `data/summary/<id>.md`）、`session.create` / `session.list` / `session.messages` / `session.rename` / `session.delete`。
- **SSE 事件**：`turn_start` / `delta` / `using_tools` / `tool_result`（某次工具调用的 name/args/result）/ `turn_end` / `round_done` / `error` / `summary_done`·`summary_error`。
- **会话与消息持久化在 PostgreSQL**（`<prefix>_sessions` / `<prefix>_messages` 两张表），刷新/重开会话会从 DB 还原历史；删除会话级联删消息。
- **消息时间戳**：每条气泡下方显示发送时间（`2026-6-2 18:23`）。**纯前端展示**——live 消息用浏览器当前时间，历史消息用 DB `messages.created_at`（该列由 `DEFAULT now()` 自动生成，app 不额外写入）。

> ⚠️ runtime 用 `tsx` 启动、不 watch：改了服务端代码（尤其 `server/rpc.ts` 新增 method）后要**重启 runtime**，否则前端调新 method 会收到 `未知方法: xxx`。

---

## 运行流程

1. **启动时**：所有 agent 的种子文件灌入对应 PostgreSQL 表（content + embedding + metadata）。
2. **架构师输入需求** → 进入 LangGraph 流程。
3. **每个 Agent 节点**（`BaseAgent.invoke`，两阶段）:
   - **Phase 1 工具循环**：构造阶段就把一批工具 `bindTools` 到 LLM，LLM 自主决定调哪个（最多 3 轮）。工具有：`rag_search`（私有 RAG，PostgreSQL hybrid pg_trgm+pgvector + 本地 rerank）、`echo` / `list_processes` / `list_dir` / `read_file`（命令行 / 文件）、`AIsearch`（经 MultiServerMCPClient 接入百度 AI Search MCP 联网搜索）。每次调用的 `{name,args,result}` 收进 `tool_calls` 落库 + 经 `tool_result` 事件推给前端。
   - **Phase 2 结构化收尾**：用 `withStructuredOutput` 强制 LLM 产出 `ModelOutput { content, next_agent, done }`。
4. **条件边路由 (`routeToWhichAgent`)**: `iteration ≥ max → END`；`done → END`；`next_agent ∈ AGENT_NAMES → 对应节点`；兜底回 architect。
5. **架构师复盘**：CLI 提示是否继续新一轮或退出。

---

## 关键技术决策

| 设计 | 理由 |
|------|------|
| PostgreSQL 三合一（存储 + 关键字 + 向量） | 一套 PostgreSQL 同时承担文档存储、pg_trgm 关键字召回、pgvector cosine kNN，无需额外向量库 |
| `@huggingface/transformers` 本地 embedding | 不依赖外部 API；Transformers.js 直接在 Node 端跑 ONNX |
| **本地 cross-encoder 重排** | 混合检索召回宽，rerank 精确收敛；改用本地模型后**免联网、免 API 费用**，函数接口与旧 Cohere 版完全兼容 |
| 候选 `top_20` → 重排 `top_5` | 召回阶段宁多勿少；rerank 阶段宁精勿滥，留 5 条给 LLM 控住上下文长度 |
| `Annotation` 追加式 messages | 保留完整讨论历史，符合 LangGraph 语义 |
| 结构化输出 `ModelOutput` | 用 `withStructuredOutput` 拿 `{content, next_agent, done}`，比解析字符串标记更稳 |
| 架构师 = human-in-the-loop | 每轮结束由人工决定继续/退出 |
| `maxIterations` 安全阀 | 防止 Agent 间无限循环 |

---

## 常用操作

**重置某个 Agent 的 PostgreSQL 表**：

```bash
pnpm --filter @meetmind/runtime exec tsx -e "import('./src/database/initializer.ts').then(m => m.resetAgentDb('backend'))"
```

**完全清空 + 重灌**：

```bash
docker compose down -v && docker compose up -d
pnpm dev                  # 启动时会自动重灌
```

**修改混合检索 / rerank 参数**：编辑 `.env` 中的 `RETRIEVE_TOP_N`、`RERANK_TOP_N`。

**换 rerank 模型**：编辑 `.env` 中的 `RERANK_MODEL_NAME`（需是 Transformers.js 兼容的 cross-encoder，如 `Xenova/ms-marco-MiniLM-L-6-v2`）和 `RERANK_DTYPE`（`q8` / `fp32` 等）。

**增加新 Agent**：

1. `apps/runtime/src/config/constants.ts` 加入名字；
2. 复制一个 agent 类实现 `systemPrompt`；
3. `apps/runtime/src/graph/builder.ts` 的 `buildAllAgents()` 注册；
4. 在 `data/seed/<name>/` 放种子文件。

**新增工具**：在 `apps/runtime/src/tools/` 建一个 `<xxx>Tool.ts` 导出 `tool()` 单例，再到 `toolRegister.ts` 加一行 import + 一行 `register`（所有 agent 共用同一批工具）。接外部 MCP 走 `tools/mcp/mcpClient.ts`。

**切换 LLM 提供商**：只要提供 OpenAI 兼容端点，改 `.env` 中的 `BASE_URL` 与 `MODEL_NAME` 即可。若新提供商不支持 `extra_body.thinking`，可在 `apps/runtime/src/agents/base.ts` 中删除 `modelKwargs.thinking` 参数。

---

## 依赖

- Node ≥ 20，包管理用 **pnpm**
- `@langchain/core`, `@langchain/openai`, `@langchain/langgraph`, `@langchain/textsplitters`
- `pg` (8.x，PostgreSQL 客户端；服务端需 pgvector 扩展)
- `@huggingface/transformers`（embedding + 本地 rerank，含 ONNX runtime）
- `pdfjs-dist`, `mammoth`（PDF / DOCX 解析）
- `zod`, `dotenv`
- `chalk`, `ora`, `boxen`, `cli-table3`（CLI 美化）

完整依赖见 [`package.json`](./package.json)。
