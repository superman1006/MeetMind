# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

MeetMind 是一个多 Agent RAG 协作系统的 demo（**TypeScript 版**，原 Python 版已整体迁移、`meetmind/*.py` 已删除，代码现在全在 `src/`）：5 个角色 Agent（架构师、后端、前端、测试、产品经理）围绕一个项目需求展开讨论。架构师作为入口和终止者，其他角色在 LangGraph 条件边的驱动下自由路由。每个 Agent 拥有独立的 PostgreSQL 表 + 私有 RAG 工具（**PostgreSQL 混合检索：pgvector 向量 kNN + pg_trgm 关键字召回**，再过 **本地 cross-encoder rerank**）。存储已从 Elasticsearch 迁移到 PostgreSQL（pgvector）。

LLM 通过 OpenAI 兼容协议调用（默认配置小米 MiMo），所以 `new ChatOpenAI({...})` 里有一个 `modelKwargs: { thinking: { type: "disabled" } }`（对标旧 Python 端的 `extra_body={"thinking": {"type": "disabled"}}`）不能改。

## 常用命令

包管理用 **pnpm**，不要用 npm / yarn。运行用 **tsx** 直接跑 `.ts`，开发期不需要预编译。

```bash
# 第一次（或换机）启动:
docker compose up -d                   # 起本地单节点 PostgreSQL+pgvector (pgvector/pgvector:pg17, 宿主机端口 5433)
pnpm install                           # 安装依赖（无 torch；主要是 onnxruntime + langchain + pg，首次较慢）
pnpm dev                               # tsx src/index.ts 启动 CLI
pnpm start                             # 同上

# 生产 / 编译:
pnpm build                             # tsc 编译到 dist/
pnpm start:prod                        # node dist/index.js
pnpm typecheck                         # tsc --noEmit，只做类型检查

# 重置某个 agent 的 PostgreSQL 表并重灌（开发时常用）
pnpm exec tsx -e "import('./src/database/initializer.ts').then(m => m.resetAgentDb('backend'))"

# 完全抹库后重灌（删 docker volume，下次启动重新建表 + 灌种子）
docker compose down -v && docker compose up -d
```

环境变量在 `.env`（参考 `.env.example`）：LLM 三件套 `API_KEY` / `BASE_URL` / `MODEL_NAME` 是调用 LLM 的必需项；`PG_URL` 默认 `postgresql://meetmind:meetmind@localhost:5433/meetmind`（宿主机 5432 常被本地原生 postgres 占用，docker-compose 把容器映射到 **5433** 避让）。**rerank 已改为本地 cross-encoder，不再需要 `COHERE_API_KEY`。** 启动时唯一的硬退出是 `pingDb()` 失败（`process.exit(1)`）；LLM 的 key/baseUrl 缺失不会在启动时被拦截，会在第一次调用模型时抛错（zod 对这些字段给空字符串默认值，不报错）。

## 高层架构

### 调用链一句话

```
src/index.ts (load dotenv) → cli/main.ts:main() → [printAppBanner / bootstrap / buildGraph / while true]
                                              ↓
              graph.stream() → createNode(agent) 闭包 → agent.invoke()（Phase1 工具循环 + Phase2 结构化收尾）
                                              ↓
                                    routeToWhichAgent(state) → 下一个 _node 或 END
```

### 三层职责分离

1. **`src/agents/`** — 角色定义。子类只重写 `get systemPrompt()`，公共能力都在 `BaseAgent` 里。`BaseAgent.invoke()` 是核心，**分两阶段**：(0) 用 `cleanBadChars` 清掉 stdin 来的孤立 surrogate 码点；(1) **Phase 1 工具循环** —— `bindTools([ragTool])` 让 LLM 自主调 RAG，最多 `_MAX_TOOL_ITERATIONS=5` 轮；(2) **Phase 2 结构化收尾** —— `withStructuredOutput(ModelOutputSchema)` 强制 LLM 输出 `{content, next_agent, done}` 三字段，`_buildAgentResponse` 把 `done` 字符串 coerce 成 bool、校验 `next_agent` 合法性。

2. **`src/graph/`** — LangGraph 编排。`AgentStateAnnotation`（`Annotation.Root`）是共享状态（`messages` 用 `concat` reducer 追加、其他字段用 `(_e,u)=>u` 覆盖）；`routeToWhichAgent` 是所有节点共用的条件边函数，按 `iteration >= maxIterations` → `state.done` → `isAgentName(state.next_agent)` → `architect_node` 兜底的顺序决定下一节点。

3. **`src/database/`** — RAG，**PostgreSQL（pgvector）+ 全本地模型**（embedding 与 rerank 都走 `@huggingface/transformers`，不再依赖 Cohere / ES）。`client.ts` 负责 `pg.Pool` 单例 + 每 agent 一张表（列：`id text 主键`、`content text`、`metadata jsonb`、`embedding vector(dim)`），并 `ensureExtensions()` 建好 `vector`(pgvector) 与 `pg_trgm` 两个扩展、给表建 HNSW 向量索引 + GIN trigram 索引；`embedding.ts` 用 `@huggingface/transformers` 本地加载 `Xenova/all-MiniLM-L6-v2` 算 384 维向量；`initializer.loadSeedsToPg` 跑「load → split → embed → INSERT ... ON CONFLICT DO NOTHING」灌库，用 `<agent>_md5(content)[:12]` 作为主键 `id` 实现幂等；`rag_retriever.RAGRetriever.retrieve(query)` 是核心：**并行跑关键字召回（`word_similarity` / pg_trgm）+ 向量 kNN（`<=>` cosine / pgvector）→ 按行 `id` 去重合并 → 全部送 `reranker.rerank()` 跑本地 cross-encoder（`Xenova/bge-reranker-base`）→ 按 relevanceScore 排序返回 top-K**。候选数和返回数分别由 `RETRIEVE_TOP_N=20` 和 `RERANK_TOP_N=5` 控制。

### 关键设计点

- **路由协议从字符串标记改为结构化输出**：旧版本 Agent 在回复末尾写 `[NEXT_AGENT: name]` / `[DONE]` 再用正则解析；现在改为 zod `ModelOutputSchema = { content, next_agent, done }` + `withStructuredOutput`。已**没有** `_get_next_agent` 正则函数，解析与兜底都在 `_buildAgentResponse`：`done` 接受 `"true"/"yes"/"1"/"y"/"done"/"完成"` 视为真，`next_agent` 不在 `AGENT_NAMES` 里时兜底回 architect，保证图永远不卡死。
- **invoke 是两阶段（先工具、后收尾）**：Phase 1 只 `bindTools`、不约束格式，让 LLM 自由调 RAG；Phase 2 只 `withStructuredOutput`、不带工具，追加一条 wrap-up 的 `HumanMessage` 要求按 `ModelOutput` 汇总。两阶段分开是因为「边调工具边强制结构化」在很多 OpenAI 兼容后端上不稳。
- **RAG 是 Tool 不是 prompt 注入**：`getTool()` 把检索器包成 LangChain `tool()`（名字 `rag_search_<agent>`），LLM 用 function-calling 自主决定是否调用。代价是模型必须支持 OpenAI function calling 协议。
- **rerank 已本地化**：旧版调 Cohere `rerank-v4.0-pro` API；现在用 `@huggingface/transformers` 在本地跑 cross-encoder（默认 `Xenova/bge-reranker-base`，`dtype=q8`），逐条算 query↔候选 的 logit 过 sigmoid 当 relevanceScore。失败时降级为「原序返回前 N 条」（见 `reranker.rerank` 的 catch 分支），不让链路断。返回结构与旧 Cohere 版一致，上游 `rag_retriever` 无需改。
- **embedding 也本地化**：`@huggingface/transformers` 的 feature-extraction pipeline 加载 `Xenova/all-MiniLM-L6-v2`（ONNX，`dtype=fp32`），mean pooling + 归一化，输出 384 维直接做余弦检索。与 Python sentence-transformers 同款模型，向量空间近似一致（ONNX vs PyTorch 数值非逐位等同，语义可用）。
- **路径相对性**：`config/settings.ts` 里 `resolveRel` 作为 zod `.transform` 把 `.env` 里 `SEED_DATA_PATH=./data/seed`、`EMBEDDING_CACHE_DIR=./models` 这类相对路径自动锚定到 `PROJECT_ROOT`。不要去掉这个 transform，否则从 IDE / 不同 cwd 启动会找不到种子 / 模型目录。
- **首次启动会下载模型到 `./models/`**：embedding `Xenova/all-MiniLM-L6-v2` ~80MB；reranker `Xenova/bge-reranker-base`（q8）~280MB。都是一次性，缓存目录由 `EMBEDDING_CACHE_DIR` 决定（reranker 复用同一目录）。**TS 版没有 torch**，依赖体积比 Python 版小很多。
- **种子目录结构**：`data/seed/<agent>/*.{json,pdf,docx,md,txt}` —— 把任意支持的文件丢进对应 agent 子目录即可。`loaders.ts` 按后缀分发，`splitters.ts` 再按 `type` 字段二次切块。目录不存在时回退旧布局 `data/seed/<agent>_seeds.json`。重灌某 agent 用 `resetAgentDb('xxx')`；抹整库用 `docker compose down -v`。
- **PostgreSQL 是硬依赖**：CLI 启动会 `pingDb()`（`SELECT 1`），挂了直接 `process.exit(1)`。本地默认走 `docker-compose.yml` 起的 `pgvector/pgvector:pg17` 单节点（用户 / 库 / 密码都是 `meetmind`，宿主机端口 **5433**）。生产改 `.env` 的 `PG_URL` 指向已有实例即可（连接串自带账号密码）。**镜像必须带 pgvector 扩展**——stock `postgres` 镜像没有 `vector`，向量检索会建表失败。

## 这个仓库的命名习惯（重要：不要"修正"）

仓库主人保留了一些**为了跨语言一致 / 有意为之**的命名，遇到时请遵循，不要自动重命名：

| 项 | 当前命名 | 备注 |
|---|---|---|
| `BaseAgent` 实例上的 RAG 引用 | `this.RAGRetriever` | 刻意 PascalCase，不是 `this.ragRetriever`（沿用 Python 端约定） |
| State / 响应 / MessageTurn 字段 | `next_agent` / `agent_name` / `used_rag` / `done` | 刻意 snake_case，会序列化进 LangGraph state，跨语言一致优先于 TS camelCase |
| 图节点名 | `` `${name}_node` `` | snake_case 后缀，如 `architect_node` |
| BaseAgent prompt 拼装 | `_userPrompt(requirement, history)` / `_routingPrompt()` | 不是 `_buildUserPrompt` / `_routingInstructions` |
| BaseAgent 主方法 | `invoke(requirement, conversationHistory)` | 不是 `process()` |
| 路由 / 收尾解析 | `_buildAgentResponse(output)` | 结构化输出后构造 AgentResponse；**没有** `_getNextAgent` / `_parseRouting`（旧正则方案已删） |
| 字符清理 | `cleanBadChars(text)` | 模块级导出函数 |
| RAG 工具 | `RAGRetriever.restart()` / `.getTool()` | 不是 `resetTracking()` / `asLangchainTool()`；直接查 PostgreSQL，不需要 `markDirty()` |
| Initializer 私函数 | `loadSeedsToPg` / `getSeedsContent` / `generateDocId` / `getExistingIds` | 单 agent 灌库入口是 `loadSeedsToPg`（ES 时代叫 `loadSeedsToEs`），不是 `_populateOneAgent` |
| Initializer 入口 / 重置 | `buildAgentsIndices()` / `resetAgentDb(agent)` | 入口名保留 `buildAgentsIndices`（历史叫法），实际建的是 PostgreSQL 表 |
| PostgreSQL 连接池 / 表 | `getPgPool()` / `ensureExtensions()` / `ensureAgentTable(agent)` / `countDocs(agent)` / `deleteAgentTable(agent)` | 表名由 `getTableName(agent)` → `<prefix>_<agent>`（ES 时代是 `getEsClient` / `ensureAgentIndex` / `getIndexName`） |
| CLI 复盘 / 输出 | `printRoundReview(state)` / `printAgentInfo(...)` | 不是 `formatAgentOutput()` |
| State 完成字段 | `state.done` | 不是 `complete` |
| 结构化输出 schema | `ModelOutputSchema` / `ModelOutput` | zod schema + 推导类型 |

写注释优先用中文，符合现有风格。

## 容易踩的坑

- **进程入口顺序**：`src/index.ts` 必须先 `config()`（dotenv）再动态 `import("./cli/main.js")`，因为 LangSmith 等 SDK 在 import 时就读 `process.env`。另外 `settings.ts` 在 import 期也会自行 `loadDotenv`，所以单独 import 模块跑脚本（如 reset）时也能读到 .env。
- **import 路径要带 `.js` 后缀**：项目是 ESM + NodeNext，所有相对 import 写成 `./foo.js`（即便源文件是 `foo.ts`）。这是 TS 在 NodeNext 下的硬要求，不是笔误。
- **stdin 编码**：`cli/main.ts` 里 `process.stdin.setEncoding("utf8")` + `BaseAgent.invoke` 里的 `cleanBadChars` 是两道防线，避免中文输入产生孤立 UTF-16 surrogate 导致下游 HTTP 客户端序列化崩。两者都要保留。
- **rerank/embedding 失败降级**：所有检索直接查 PostgreSQL，无内存索引，灌库后无需通知 RAGRetriever。本地 rerank 模型加载或前向失败时，`rerank` 内部降级为「原序返回前 N 条」（score=0），不会让链路完全断；关键字 / 向量任一路检索 SQL 抛错时，`bm25Search` / `knnSearch` 各自 catch 返回空数组，另一路仍可独立工作。
- **关键字召回用 `pg_trgm` 的 `word_similarity`**：对中文按 trigram（3 字一组）算重叠，比 jieba 粗、比 ES `standard` 单字切更严（只在有 3 字共现时才命中）。**但因为后面有本地 cross-encoder rerank + 向量 kNN 兜底**，关键字粗一点没关系。`bm25Search` 用 `WHERE word_similarity($1, content) > 0` 只取有重叠的候选；想要精细中文分词可装 `pg_jieba` / `zhparser` 改走 tsvector 全文检索。
- **向量维度建表时确定**：`ensureAgentTable` 建表前会先 `getEmbedModelDim()` 探一次维度（跑一条样本 embedding），列类型是 `vector(dim)`。换 embedding 模型会改维度 → 旧表不兼容，得 `deleteAgentTable` 或 `docker compose down -v` 重建。
- **LangGraph 节点返回值按 Annotation 合并进 State**：`messages` 走 `concat` reducer 追加，其他字段覆盖。在 `createNode` 闭包里只 return 增量更新即可。
- **表名约定** `<pg_table_prefix>_<agent>`（默认 `meetmind_architect` 等）。换前缀（`PG_TABLE_PREFIX`）后旧表不会自动迁移，得手动迁移或 `docker compose down -v` 重灌。表名只由受控 prefix + 固定 agent 名拼成（合法标识符），所以 DDL / 检索 SQL 里直接字符串内插表名是安全的，而正文 / 向量 / 参数一律走 `$n` 占位符。
- **`.env.example` 里的 `EMBEDDING_MODEL_NAME` 写的是 `sentence-transformers/...`**，但 `settings.ts` 默认值是 `Xenova/all-MiniLM-L6-v2`。`@huggingface/transformers` 需要带 ONNX 权重的仓库（`Xenova/*`），改 embedding 模型时注意选 ONNX 版，否则加载会失败。

## 编码风格

**核心原则：代码首先是写给人看的，不是给机器优化的。** 任何陌生人第一次读代码，不应该需要反向推导才能明白每一行在做什么。这条在 TS 版同样成立——现有代码到处是显式 `for` 循环 + 具名中间变量，而不是 `.map().filter()` 链。

具体禁止的写法：

- **禁止数组方法链做数据管道**（`xs.map(...).filter(...).reduce(...)`）：用显式 `for` 循环 + `push` / 赋值替代；
- **禁止嵌套 / 复杂三元表达式**：多分支或带副作用的判断用 `if/else` 块展开，每个分支单独一行；
- **禁止多层链式调用**（`a.b().c()` 或 `fn1(fn2(x))`）：把每一步的结果赋给一个有名字的中间变量，再传给下一步；
- **中间结果必须命名**：每一步计算产生的值，用一个见名知意的变量名存起来，不要直接嵌入下一层调用。

例外：以下场景不受此限制——

- 单层、语义一目了然的三元用于「默认值 / 类型收窄」（如 `typeof x === "string" ? x : ""`、`date ? a : b`）以及 `??` / 可选链 `?.`；
- `Array.join()` 的直接用法（`lines.join("\n")`），前提是 `lines` 已经是具名变量；
- `logger.info(...)` 等日志调用内部的简单模板字符串；
- 两层以内、语义一目了然的属性访问（`settings.pgUrl`）。

## 项目入口

`src/index.ts` 是薄壳：`config()` 加载 .env，再动态 `import("./cli/main.js")` 调 `main()`。真正的 CLI 逻辑在 `src/cli/main.ts:main()`。
