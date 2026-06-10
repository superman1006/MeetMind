<div align="center">

<img src="assets/banner.png" alt="MeetMind"/>

### 数字分身会议协作系统 · AI Digital Avatars that Meet, Discuss & Summarize

**English** ｜ [简体中文](README.zh-CN.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![LangGraph](https://img.shields.io/badge/LangChain%20%2F%20LangGraph-1C3C3C?style=flat&logo=langchain&logoColor=white)](https://langchain-ai.github.io/langgraphjs/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![pgvector](https://img.shields.io/badge/pgvector-008BB9?style=flat)](https://github.com/pgvector/pgvector)
[![Transformers.js](https://img.shields.io/badge/Transformers.js-FFD21E?style=flat&logo=huggingface&logoColor=black)](https://huggingface.co/docs/transformers.js)

[![Quick Start](https://img.shields.io/badge/Quick_Start-00C853?style=flat&logo=rocket&logoColor=white)](#quick-start)
[![License MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-D97757?style=flat&logo=anthropic&logoColor=white)](https://claude.com/claude-code)
[![Codex](https://img.shields.io/badge/Codex-000000?style=flat&logo=openai&logoColor=white)](https://openai.com/codex/)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-4285F4?style=flat&logo=googlegemini&logoColor=white)](https://github.com/google-gemini/gemini-cli)
[![Cursor](https://img.shields.io/badge/Cursor-000000?style=flat&logo=cursor&logoColor=white)](https://cursor.com/)
[![Trae](https://img.shields.io/badge/Trae-FF3B30?style=flat)](https://trae.ai/)

> This project can be co-developed and extended with AI coding assistants such as **Claude Code / Codex / Gemini CLI / Cursor / Trae**.

</div>

---

A multi-role Agent collaboration demo (TypeScript implementation) built on **LangChain + LangGraph + PostgreSQL (pgvector) + a local cross-encoder reranker**.
It simulates an R&D project team: 5 Agents — Architect, Backend, Frontend, Test, and Product Manager — each of which has:

- a **dedicated PostgreSQL table** (storage + pg_trgm keyword recall + pgvector vector search, all in one);
- a **RAG retrieval Tool** (a LangChain `Tool`) that performs **hybrid retrieval + local rerank** under the hood;
- its own **System Prompt** and LangGraph node;
- routing of the next speaking Agent via a structured-output **`next_agent` field** (free routing / `conditionalEdges`).

The LLM is accessed over the **OpenAI-compatible protocol** (`ChatOpenAI` from `@langchain/openai`), targeting Xiaomi MiMo by default.

---

## RAG Retrieval Pipeline

```
user query
   │
   ├──► pg_trgm keyword recall → top_20 candidates ─┐
   │                                                ├──► merge & dedup ──► local cross-encoder rerank
   ├──► transformers.js                             │                      (Xenova/bge-reranker-base)
   │    → query embedding                           │                           │
   └──► pgvector kNN vector search → top_20 ────────┘                           ▼
                                                                       final top_5 to the LLM
```

- **Storage + retrieval**: a single PostgreSQL (pgvector) instance handles all three of "document storage (table) + keyword recall (pg_trgm word_similarity) + vector index (pgvector cosine kNN)".
- **Embedding**: local `@huggingface/transformers` (Transformers.js) running `all-MiniLM-L6-v2` (384-dim); on first launch it downloads ~80MB to `./models/`.
- **Rerank**: candidates are sent to a **local cross-encoder** (default `Xenova/bge-reranker-base`, also via `@huggingface/transformers`) that scores query↔candidate relevance one by one, normalizes with sigmoid, and takes top_n for the LLM. **No network and no API key required**; on failure it degrades to returning the first N candidates in original order.

---

## Quick Start

### 1. Install dependencies

```bash
cd /Users/chenlv/Project/MeetMind
pnpm install
```

Dependencies include `pg` (PostgreSQL client) / `@huggingface/transformers` (embedding + rerank, local inference) / `@langchain/*`.

### 2. Start PostgreSQL (with pgvector)

```bash
docker compose up -d
# verify: docker exec meetmind-pg pg_isready -U meetmind
#         or psql postgresql://meetmind:meetmind@localhost:5433/meetmind
```

`docker-compose.yml` brings up a single-node `pgvector/pgvector:pg17` (user/db/password are all `meetmind`), **mapping the host port to 5433** (to avoid the 5432 commonly taken by a native local postgres). The image ships the `vector` extension; after startup the app automatically runs `CREATE EXTENSION vector / pg_trgm`.

### 3. Configure .env

```bash
cp .env.example .env
# required:
#   API_KEY / BASE_URL / MODEL_NAME      ← LLM (OpenAI-compatible endpoint)
# optional defaults:
#   PG_URL=postgresql://meetmind:meetmind@localhost:5433/meetmind
#   PG_TABLE_PREFIX=meetmind
#   EMBEDDING_MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2
#   RERANK_MODEL_NAME=Xenova/bge-reranker-base   RERANK_DTYPE=q8   ← local rerank (no key)
#   RETRIEVE_TOP_N=20   RERANK_TOP_N=5
```

### 4. Run

```bash
pnpm dev
# or run after building:
pnpm build && pnpm start:prod
```

On startup it will:
- ping PostgreSQL (`SELECT 1`; exits immediately if it fails)
- print local rerank model info (no Cohere key needed anymore)
- scan `data/seed/<agent>/` and list all seed files
- load the embedding model (~80MB on first run)
- import into PostgreSQL (create tables + extensions/indexes; `ON CONFLICT` is idempotent, existing ids are skipped)

> The first time rerank is triggered (the first time an Agent calls the RAG tool) it downloads the rerank model once more (default q8 quantization, ~280MB).

---

## Monorepo Startup (runtime + desktop)

Prerequisites: `docker compose up -d` to start PostgreSQL; `pnpm install` on first run.

- Start frontend + backend together: `pnpm dev`
- Backend service only (3002): `pnpm dev:runtime`
- Frontend only (5173, browser debugging): `pnpm dev:desktop`
- Legacy CLI (kept, no longer the default entry): `pnpm dev:cli`
- Desktop shell (requires Rust first): `pnpm --filter @meetmind/desktop tauri dev`

The backend on 3002 exposes `POST /api` (JSON-RPC) and `GET /events?sessionId=…` (SSE):

- **JSON-RPC methods**:
  - *chat*: `chat.send` (start a round, runs in the background and returns immediately, progress via SSE), `chat.interrupt` (abort and discard the current round without persisting), `chat.summaryTitle` (auto-name a new session from its first input), `chat.compact` (roll older history into a summary once token usage hits a threshold), `chat.getResumable` / `chat.resume` / `chat.discardResumable` (crash-recovery for an unfinished round), `chat.end` (end the meeting → generate minutes into `data/summary/<id>.md`).
  - *session* (per-user): `session.create` / `session.list` / `session.messages` / `session.rename` / `session.delete`.
  - *user*: `user.login` / `user.registry` / `user.getMemory` / `user.setMemory` (accounts + per-user memory injected into the system prompt).
  - *tool*: `toolApproval` (resolve a pending HITL approval).
  - *model*: `model.get` / `model.set` (hot-swap the LLM endpoint, rebuilds the graph) / `model.test` (probe connectivity).
- **SSE events**: `turn_start` / `delta` / `using_tools` / `tool_approval_request` (HITL: wait for the user before a risky tool) / `tool_result` (a tool call's name/args/result) / `turn_end` / `round_done` / `error` / `summary_done`·`summary_error`.
- **Sessions and messages are persisted in PostgreSQL** (the `<prefix>_sessions` / `<prefix>_messages` tables, scoped per user); refreshing/reopening a session restores history from the DB; deleting a session cascades to its messages. The graph also writes LangGraph checkpoints to its own `checkpoint*` tables for crash recovery.
- **Message timestamps**: each bubble shows its send time below (`2026-6-2 18:23`). **Frontend-only display** — live messages use the browser's current time, history messages use the DB `messages.created_at` (that column is auto-generated by `DEFAULT now()`, the app does not write it explicitly).

> ⚠️ The runtime starts via `tsx` without watch: after changing server code (especially adding a method in `server/rpcServer.ts`) you must **restart the runtime**, otherwise the frontend will get `未知方法: xxx` when calling the new method.

---

## Project Structure

This is a **pnpm monorepo** with two apps:

```text
MeetMind/
├── package.json                     # root workspace: dev / dev:runtime / dev:desktop / typecheck / build / test
├── pnpm-workspace.yaml              # workspace declaration (apps/*)
├── pnpm-lock.yaml                   # lockfile (use pnpm for package management)
├── tsconfig.base.json               # shared TS config
├── docker-compose.yml               # local single-node PostgreSQL+pgvector (pgvector/pgvector:pg17, host port 5433)
├── .env.example / .env              # env var template / real runtime config (.env at root, shared by both apps)
├── README.md / project_flow.md / CLAUDE.md
├── models/                          # local cache for embedding / rerank models (git-ignored, shared by both apps)
├── data/
│   ├── seed/<agent>/                # ★ RAG seed docs (input) *.{json,pdf,docx,md,txt}
│   └── summary/<sessionId>.md       # meeting minutes generated after a session ends
│
└── apps/
    ├── runtime/                     # ★ backend: multi-Agent discussion + RAG + persistence + HTTP/SSE service (3002)
    │   ├── src/  (agents / graph / database / tools / server / config / utils / cli)
    │   └── README.md                # → backend details
    └── desktop/                     # ★ frontend: Vue 3 + Vite + Tauri 2 desktop shell
        ├── src/  (api / stores / components / theme)
        ├── src-tauri/               # Tauri native shell (Rust)
        └── README.md                # → frontend details
```

- **Backend [`apps/runtime/README.md`](apps/runtime/README.md)** — engine + tool layer (RAG / shell / files / MCP web search) + PostgreSQL persistence + HTTP/SSE service.
- **Frontend [`apps/desktop/README.md`](apps/desktop/README.md)** — chat-style UI, streaming discussion, tool-call buttons + result panel.
- **Function-by-function call chain [`project_flow.md`](project_flow.md)** — the full runtime call chain + SSE event contract.

> Notes:
> - PostgreSQL data lives in the docker volume `meetmind_pg_data` (outside the project directory); removing it with `docker compose down -v` triggers a seed re-import on the next launch.
> - Both the embedding and rerank models are cached in-project under `./models/` (controlled by `EMBEDDING_CACHE_DIR`), each downloaded once on first launch.

---

## Request Routing (preprocess pipeline)

Every round enters a 3-node preprocess pipeline **before** any role speaks — it runs once at the graph entry, never participates in inter-agent routing, and never counts toward `iteration`:

```
START → rewrite_node → intent_node → route_node ──┬─► assistant_node → END      (right-side single-node "answer assistant")
                                                  └─► architect_node → … team   (left-side 5-role collaboration)
```

1. **`rewrite_node`** — one LLM call (`withStructuredOutput`) produces a **standalone, resolved query** (`rewritten_query`, coreference resolved against recent history) plus **expansion terms** (`expansion_terms`, fed only to the retrieval layer to boost recall). On failure it degrades to the raw input.
2. **`intent_node`** — local zero-shot NLI (`Xenova/mDeBERTa-v3-xnli`, lazy ONNX singleton) classifies into one of 4 labels (`闲聊` / `知识问答` / `开发需求` / `任务指令`) and records the **top-1 vs top-2 score margin**. Two rule short-circuits skip the fragile NLI: a greeting whitelist (`CHITCHAT_GREETINGS`, whole-sentence match → `闲聊`) and a dev-keyword whitelist (`TEAM_KEYWORDS` — 项目 / 架构 / 测试 / 前端 / 后端 / …, *contains* match → `开发需求`).
3. **`route_node`** — decides by **margin**, not an absolute threshold: NLI softmax over 4 labels hugs the uniform line (0.25), so an absolute score rarely passes. If `margin ≥ INTENT_ROUTE_MARGIN` (default `0.08`) the classification is trusted and routed by intent (`闲聊`/`知识问答` → assistant, otherwise → team); if the margin is too small the call is "undecidable" and **defaults to the lightweight assistant** (a single answer is cheaper than waking the whole team).

The **answer assistant** (`assistant_node`) reuses the same construction-time model + tool set but runs `assistant.answer()` instead of the two-phase collaboration: one tool loop + a plain natural-language streamed wrap-up (no structured output, no `next_agent`), then straight to `END`. It shares only `AgentState` (history / memory) with the team and never touches `iteration`.

## Runtime Flow (left-side team)

1. **On startup**: every agent's seed files are imported into its PostgreSQL table (content + embedding + metadata).
2. **A requirement enters** → the preprocess pipeline routes it to the team (`architect_node`).
3. **Each Agent node** (`BaseAgent.invoke`, two phases):
   - **Phase 1 tool loop**: a batch of tools is `bindTools`-bound to the LLM at construction time; the LLM decides which to call (up to 3 iterations). Tools: `rag_search` (private RAG), `Read` / `list_dir` / `glob` / `grep` / `echo` / `list_processes` (read-only, low risk), `Edit` / `web_fetch` (medium risk), `Write` (high risk), `skill`, and `AIsearch` (Baidu AI Search MCP web search via MultiServerMCPClient). Before a tool whose `risk > low` runs, the node emits a `tool_approval_request` event and **waits for human approval (HITL)**. Each call's `{name,args,result}` is collected into `tool_calls` for persistence and pushed to the frontend via a `tool_result` event.
   - **Phase 2 structured wrap-up**: uses `withStructuredOutput` to force the LLM to produce `ModelOutput { content, next_agent, done }`.
4. **Conditional edge routing (`routeToWhichAgent`)**: `iteration ≥ max → END`; `done → END`; `next_agent ∈ AGENT_NAMES → the corresponding node`; otherwise falls back to the architect.
5. **Architect review**: the human decides whether to continue with a new round or end the meeting.

> **Crash recovery**: the compiled graph runs with a `PostgresSaver` checkpointer, so an interrupted round leaves a checkpoint. On reopening a session the frontend can detect the pending thread (`chat.getResumable`) and either **resume** it from the checkpoint (`chat.resume`) or **discard** it (`chat.discardResumable`).

---

## Key Technical Decisions

| Design | Rationale |
|------|------|
| PostgreSQL all-in-one (storage + keyword + vector) | One PostgreSQL handles document storage, pg_trgm keyword recall, and pgvector cosine kNN at once, no separate vector DB needed |
| `@huggingface/transformers` local embedding | No dependency on external APIs; Transformers.js runs ONNX directly in Node |
| **Local cross-encoder reranking** | Hybrid retrieval recalls broadly, rerank converges precisely; with a local model it is **network-free and API-fee-free**, and the function interface is fully compatible with the old Cohere version |
| Candidates `top_20` → rerank `top_5` | Recall stage: better too many than too few; rerank stage: better precise than loose, leave 5 for the LLM to keep context length in check |
| `Annotation` append-only messages | Keeps the full discussion history, matching LangGraph semantics |
| Structured output `ModelOutput` | Use `withStructuredOutput` to get `{content, next_agent, done}`, more robust than parsing string markers |
| Preprocess router (rewrite → intent → route) | A one-pass entry pipeline resolves the query, classifies intent locally, and splits chit-chat/Q&A to a lightweight single-node assistant vs. real dev work to the full team — runs off the LLM-driven inter-agent routing and never counts toward `iteration` |
| Margin-based routing (not absolute threshold) | NLI softmax over 4 labels hugs the uniform line; the top-1/top-2 **margin** is the trustworthy signal. Undecidable → default to the assistant (cheaper than waking the team) |
| HITL tool approval | Tools carry a `risk` level (`low`/`medium`/`high`); anything above `low` pauses for explicit user approval before executing |
| `PostgresSaver` checkpoint + resume | Every round checkpoints to PostgreSQL, so an interrupted/crashed round can be resumed or discarded on reopen |
| Context compaction | Older history rolls into a summary past a token threshold; the `messages` table is untouched so the UI still shows everything |
| Architect = human-in-the-loop | The human decides continue/exit at the end of each round |
| `maxIterations` safety valve | Prevents infinite loops between Agents |

---

## Common Operations

**Reset a single Agent's PostgreSQL table**:

```bash
pnpm --filter @meetmind/runtime exec tsx -e "import('./src/database/ingestion/initializer.ts').then(m => m.resetAgentDb('backend'))"
```

**Full wipe + re-import**:

```bash
docker compose down -v && docker compose up -d
pnpm dev                  # re-imports automatically on startup
```

**Tune hybrid retrieval / rerank parameters**: edit `RETRIEVE_TOP_N` and `RERANK_TOP_N` in `.env`.

**Swap the rerank model**: edit `RERANK_MODEL_NAME` in `.env` (must be a Transformers.js-compatible cross-encoder, e.g. `Xenova/ms-marco-MiniLM-L-6-v2`) and `RERANK_DTYPE` (`q8` / `fp32`, etc.).

**Add a new Agent**:

1. add the name in `apps/runtime/src/config/constants.ts`;
2. copy an agent class and implement `systemPrompt`;
3. register it in `buildAllAgents()` in `apps/runtime/src/graph/builder.ts`;
4. put seed files under `data/seed/<name>/`.

**Add a new tool**: create a `<xxx>Tool.ts` in `apps/runtime/src/tools/` exporting a `tool()` singleton, then add one import line + one `register` line in `toolRegister.ts` (all agents share the same set of tools). External MCP integration goes through `tools/mcp/mcpClient.ts`.

**Switch LLM provider**: as long as it offers an OpenAI-compatible endpoint, just change `BASE_URL` and `MODEL_NAME` in `.env`. If the new provider does not support `extra_body.thinking`, remove the `modelKwargs.thinking` parameter in `apps/runtime/src/agents/base.ts`.

---

## Dependencies

- Node ≥ 20, use **pnpm** for package management
- `@langchain/core`, `@langchain/openai`, `@langchain/langgraph`, `@langchain/textsplitters`
- `pg` (8.x, PostgreSQL client; the server needs the pgvector extension)
- `@huggingface/transformers` (embedding + local rerank, includes the ONNX runtime)
- `pdfjs-dist`, `mammoth` (PDF / DOCX parsing)
- `zod`, `dotenv`
- `chalk`, `ora`, `boxen`, `cli-table3` (CLI prettifying)

See [`package.json`](./package.json) for the full dependency list.
