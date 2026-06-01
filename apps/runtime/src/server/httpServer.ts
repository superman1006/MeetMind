/**
 * Node 内置 http 服务(不引 express):
 *   POST /api      —— JSON-RPC 2.0
 *   GET  /events   —— SSE 长连(?sessionId=...)
 *   CORS 放行 localhost:5173 与 tauri 来源,OPTIONS 预检直接 204。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { buildGraph } from "../graph/builder.js";
import { handleRpc, type RpcRequest } from "./rpc.js";
import { addClient, removeClient } from "./sse.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.http");
type CompiledGraph = ReturnType<typeof buildGraph>;

/** 给响应加 CORS 头。开发期 Vite 代理已同源,这里主要为 Tauri 打包态。 */
function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** 读取整个请求体为字符串。 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 处理 POST /api。 */
async function handleApi(graph: CompiledGraph, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: RpcRequest;
  try {
    body = JSON.parse(raw) as RpcRequest;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } }));
    return;
  }
  const result = await handleRpc(graph, body);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

/** 处理 GET /events:开 SSE 长连并登记到 sessionId。 */
function handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    res.writeHead(400);
    res.end("missing sessionId");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // 先发一个注释帧,促使代理立即 flush 头
  res.write(": connected\n\n");
  addClient(sessionId, res);
  req.on("close", () => {
    removeClient(sessionId, res);
  });
}

/** 起服务并监听端口。 */
export function startServer(graph: CompiledGraph, port: number): void {
  const server = createServer((req, res) => {
    setCors(res);
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === "POST" && url.pathname === "/api") {
      handleApi(graph, req, res).catch((exc) => {
        logger.error(`/api 处理失败: ${String(exc)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(exc) } }));
      });
      return;
    }
    if (method === "GET" && url.pathname === "/events") {
      handleEvents(req, res, url);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  server.listen(port, () => {
    logger.info(`MeetMind runtime 服务已启动: http://localhost:${port}  (POST /api, GET /events)`);
  });
}
