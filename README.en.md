<div align="center">

<img src="assets/banner.png" alt="MeetMind"/>

### 多 Agent RAG 协作系统 · Multi-Agent RAG Collaboration

[简体中文](README.md) ｜ **English**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![LangGraph](https://img.shields.io/badge/LangChain%20%2F%20LangGraph-1C3C3C?style=flat-square&logo=langchain&logoColor=white)](https://langchain-ai.github.io/langgraphjs/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![pgvector](https://img.shields.io/badge/pgvector-008BB9?style=flat-square)](https://github.com/pgvector/pgvector)
[![Transformers.js](https://img.shields.io/badge/Transformers.js-FFD21E?style=flat-square&logo=huggingface&logoColor=black)](https://huggingface.co/docs/transformers.js)

[![Quick Start](https://img.shields.io/badge/Quick_Start-00C853?style=flat-square&logo=rocket&logoColor=white)](#quick-start)
[![License MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-D97757?style=flat-square&logo=anthropic&logoColor=white)](https://claude.com/claude-code)
[![Codex](https://img.shields.io/badge/Codex-000000?style=flat-square&logo=openai&logoColor=white)](https://openai.com/codex/)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-4285F4?style=flat-square&logo=googlegemini&logoColor=white)](https://github.com/google-gemini/gemini-cli)
[![Cursor](https://img.shields.io/badge/Cursor-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/)
[![Trae](https://img.shields.io/badge/Trae-FF3B30?style=flat-square)](https://trae.ai/)

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

- **JSON-RPC methods**: `chat.send` (start a discussion round, runs in the background and returns immediately, progress via SSE), `chat.interrupt` (interrupt the current round, abort and discard without persisting), `chat.end` (end the meeting → generate minutes into `data/summary/<id>.md`), `session.create` / `session.list` / `session.messages` / `session.rename` / `session.delete`.
- **SSE events**: `turn_start` / `delta` / `using_tools` / `tool_result` (a tool call's name/args/result) / `turn_end` / `round_done` / `error` / `summary_done`·`summary_error`.
- **Sessions and messages are persisted in PostgreSQL** (the `<prefix>_sessions` / `<prefix>_messages` tables); refreshing/reopening a session restores history from the DB; deleting a session cascades to its messages.
- **Message timestamps**: each bubble shows its send time below (`2026-6-2 18:23`). **Frontend-only display** — live messages use the browser's current time, history messages use the DB `messages.created_at` (that column is auto-generated by `DEFAULT now()`, the app does not write it explicitly).

> ⚠️ The runtime starts via `tsx` without watch: after changing server code (especially adding a method in `server/rpc.ts`) you must **restart the runtime**, otherwise the frontend will get `未知方法: xxx` when calling the new method.

---

## Runtime Flow

1. **On startup**: every agent's seed files are imported into its PostgreSQL table (content + embedding + metadata).
2. **The Architect enters a requirement** → the LangGraph flow begins.
3. **Each Agent node** (`BaseAgent.invoke`, two phases):
   - **Phase 1 tool loop**: a batch of tools is `bindTools`-bound to the LLM at construction time; the LLM decides which to call (up to 3 iterations). Tools include: `rag_search` (private RAG, PostgreSQL hybrid pg_trgm+pgvector + local rerank), `echo` / `list_processes` / `list_dir` / `read_file` (shell / files), `AIsearch` (Baidu AI Search MCP web search via MultiServerMCPClient). Each call's `{name,args,result}` is collected into `tool_calls` for persistence and pushed to the frontend via a `tool_result` event.
   - **Phase 2 structured wrap-up**: uses `withStructuredOutput` to force the LLM to produce `ModelOutput { content, next_agent, done }`.
4. **Conditional edge routing (`routeToWhichAgent`)**: `iteration ≥ max → END`; `done → END`; `next_agent ∈ AGENT_NAMES → the corresponding node`; otherwise falls back to the architect.
5. **Architect review**: the CLI asks whether to continue with a new round or exit.

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
| Architect = human-in-the-loop | The human decides continue/exit at the end of each round |
| `maxIterations` safety valve | Prevents infinite loops between Agents |

---

## Common Operations

**Reset a single Agent's PostgreSQL table**:

```bash
pnpm --filter @meetmind/runtime exec tsx -e "import('./src/database/initializer.ts').then(m => m.resetAgentDb('backend'))"
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
