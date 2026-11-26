import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { authenticateTwin, LOGIN_SECONDS } from "../database/users/twins.js";
import { addClient, removeClient } from "./sseServer.js";
import { handleMeetingRpc } from "./meetingRpc.js";
import type { GraphHolder, RpcRequest } from "./rpcServer.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.http");
const COOKIE_NAME = "meetmind_session";
const BODY_LIMIT = 14 * 1024 * 1024;

function loginToken(req: IncomingMessage): string {
  const cookies = req.headers.cookie ?? "";
  const prefix = `${COOKIE_NAME}=`;
  for (const item of cookies.split(";")) {
    const cookie = item.trim();
    if (cookie.startsWith(prefix)) return cookie.slice(prefix.length);
  }
  return "";
}

function json(res: ServerResponse, status: number, result: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(result));
}

async function handleApi(graph: GraphHolder, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      json(res, 413, { error: { message: "请求内容过大" } });
      return;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let body: RpcRequest;
  try {
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
    return;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "无效请求" } });
    return;
  }
  const token = loginToken(req);
  const localRequest = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  const response = await handleMeetingRpc(graph, body, token, (newToken) => {
    const age = newToken ? LOGIN_SECONDS : 0;
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${newToken ?? ""}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`);
  }, localRequest);
  logger.info({ method: body.method, id: body.id, code: response.error?.code }, "JSON-RPC");
  json(res, response.error?.code === -32001 ? 401 : 200, response);
}

// 用登录 Cookie 验证 SSE 订阅，并在该登录会话过期时关闭长连接。
async function handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = loginToken(req);
  const account = await authenticateTwin(token);
  if (!account) {
    res.writeHead(401);
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  addClient(res, account.username, token);
  const expiresIn = account.expires_at.getTime() - Date.now();
  const expire = setTimeout(() => res.end(), Math.max(0, expiresIn));
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20000);
  res.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(expire);
    removeClient(res);
  });
}

// POST /api 接收业务指令，GET /events 维持服务端向前端推送的长连接。
export function startServer(graph: GraphHolder, port: number): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let request: Promise<void>;
    if (req.method === "POST" && url.pathname === "/api") {
      const contentType = req.headers["content-type"] ?? "";
      if (!contentType.startsWith("application/json")) {
        json(res, 415, { error: { message: "请求类型必须为 application/json" } });
        return;
      }
      request = handleApi(graph, req, res);
    } else if (req.method === "GET" && url.pathname === "/events") {
      request = handleEvents(req, res);
    } else {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    request.catch((error: unknown) => {
      logger.error({ errorType: error instanceof Error ? error.name : typeof error }, "HTTP 请求失败");
      if (!res.headersSent) json(res, 500, { error: { message: "服务暂时无法完成该操作" } });
      else res.end();
    });
  });

  server.listen(port, () => {
    logger.info(`MeetMind runtime 服务已启动: http://localhost:${port}  (POST /api, GET /events)`);
  });
}
