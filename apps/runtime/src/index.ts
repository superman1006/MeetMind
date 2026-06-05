/**
 * 进程入口(HTTP/SSE 服务)。
 * 顺序:dotenv → 动态 import(让 SDK 在 import 期读到 env) → bootstrap 自检灌库 → 编译图 → 起服务。
 * (CLI 仍可用 `pnpm --filter @meetmind/runtime dev:cli` 单独跑 src/cli/main.ts。)
 */
import { config } from "dotenv";

config();

// 兜底:任何漏网的 Promise rejection / 同步异常都只记日志,不让服务进程退出。
// (Node 15+ 默认会因未处理的 rejection 直接退出进程,对长跑的 HTTP 服务是致命的。)
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] 已捕获,服务继续运行:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] 已捕获,服务继续运行:", err);
});

const { bootstrap } = await import("./bootstrap.js");
const { buildGraph } = await import("./graph/builder.js");
const { startServer } = await import("./server/httpServer.js");

await bootstrap();
// 用可变 holder 包住 graph:model.set 热切换模型时会 buildGraph() 重建并换掉 holder.current。
const graphHolder = { current: buildGraph() };
startServer(graphHolder, 3002);
