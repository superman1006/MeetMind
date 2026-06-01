/**
 * 进程入口(HTTP/SSE 服务)。
 * 顺序:dotenv → 动态 import(让 SDK 在 import 期读到 env) → bootstrap 自检灌库 → 编译图 → 起服务。
 * (CLI 仍可用 `pnpm --filter @meetmind/runtime dev:cli` 单独跑 src/cli/main.ts。)
 */
import { config } from "dotenv";

config();

const { bootstrap } = await import("./bootstrap.js");
const { buildGraph } = await import("./graph/builder.js");
const { startServer } = await import("./server/httpServer.js");

await bootstrap();
const graph = buildGraph();
startServer(graph, 3002);
