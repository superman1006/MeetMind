// 这个文件:后端「接请求」的总入口(HTTP 服务器,像餐厅前台:看你要办什么、领到对应窗口)。
// 对外开两个窗口:POST /api(一问一答的 JSON-RPC) 和 GET /events(订阅式长连 SSE)。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { buildGraph } from "../graph/builder.js";
import { handleRpc, type RpcRequest } from "./rpcServer.js";
import { addClient, removeClient } from "./sseServer.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.http");
type CompiledGraph = ReturnType<typeof buildGraph>;

// 给响应加 CORS 头:浏览器默认只准网页找“同源”服务器要数据,这几行表示“我允许跨源来访问”。
// 开发期 Vite 代理已让前后端同源用不太上,主要是给 Tauri 打包后的窗口用。
function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// 把整个请求体读成一个字符串。请求体可能很大、是一块块(chunk)流过来的,所以先收集再拼起来转成文本。
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// 处理 POST /api:读出请求体 → 解析 → 交给 handleRpc 干活 → 把结果写回前端。
async function handleApi(graph: CompiledGraph, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 把前端送来的 JSON 文本完整读出来。
  const raw = await readBody(req);

  // 尝试把文本解析成对象;万一不是合法 JSON,回标准的 -32700 错误。
  let body: RpcRequest;
  try {
    body = JSON.parse(raw) as RpcRequest;
  } catch {
    // 出错就直接 .end 响应回去
    logger.warning({ url: "/api", httpMethod: "POST", raw }, "请求体 JSON 解析失败");
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } }));
    return;
  }

  // 打印「收到的请求」:HTTP 方法 + 路径 + JSON-RPC 方法 + id + 请求体参数。
  logger.info(
    { url: "/api", httpMethod: req.method ?? "POST", rpcMethod: body.method, id: body.id ?? null, params: body.params ?? {} },
    "← 收到请求",
  );

  // 真正的“按 method 分发并执行”交给 rpc.ts 的 handleRpc。
  const result = await handleRpc(graph, body);

  // 打印「返回的响应」:对应的 id + 完整响应体(result 或 error)。
  logger.info(
    { url: "/api", rpcMethod: body.method, id: body.id ?? null, response: result },
    "→ 返回响应",
  );

  // 把结果转回 JSON 文本发回前端:writeHead 设状态码+响应头,res.end 写完并结束本次响应。
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

// 处理 GET /events:为前端开一条 SSE 长连接并登记起来。注意它不调 res.end,让连接一直开着以便后续往里推消息。
// B 方案:整个前端只开这一条 firehose 长连,订阅所有会话,不再带 sessionId;每帧自带 sessionId,前端据此路由。
function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  // SSE 必须的三个响应头:告诉浏览器“这是事件流、别缓存、保持连接别挂断”。
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // 先写一帧注释(以 : 开头、前端会忽略),逼中间代理立刻把响应头发出去,让前端尽快确认连上了。
  res.write(": connected\n\n");

  // 打印「收到的 SSE 订阅」:HTTP 方法 + 路径。
  logger.info({ url: "/events", httpMethod: req.method ?? "GET" }, "← SSE 订阅");

  // 把这条连接登记进来(见 sseServer.ts),之后业务代码就能用 send(sessionId,...) 往它推消息。
  addClient(res);

  // 前端关页面/断网时连接会触发 close,顺手把它从登记表移除,避免往死连接里写。
  req.on("close", () => {
    logger.debug({ url: "/events" }, "SSE 连接关闭");
    removeClient(res);
  });
}








// 启动服务器并监听端口。createServer 的回调“每来一个请求”就跑一次:req=进来的请求,res=用来写回响应。
export function startServer(graph: CompiledGraph, port: number): void {
  const server = createServer((req, res) => {
    // 每来一个 HTTP 请求，就执行一次这个回调函数
    // 根据 method、pathname 分到 /api、/events 等
  
    // 任何响应都先加 CORS 头。
    setCors(res);

    // 取出这次请求的方法和路径,据此决定领到哪个窗口。
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);   // index.ts 中写了是 3002

    // OPTIONS:浏览器跨域前的“预检探路”请求,不办实事,直接回 204(成功、无内容)放行。
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // POST /api:一问一答的 JSON-RPC;用 .catch 兜底,避免处理中抛错把整个进程拖垮。
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

    // GET /events:开 SSE 长连(firehose,订阅所有会话)。
    if (method === "GET" && url.pathname === "/events") {
      handleEvents(req, res);
      return;
    }

    // 其它路径都不认识,回 404(找不到)。
    res.writeHead(404);
    res.end("not found");
  });

  // 真正开始监听端口、等前端来连;listen 的回调在端口就绪后跑一次,打条启动日志。
  server.listen(port, () => {
    logger.info(`MeetMind runtime 服务已启动: http://localhost:${port}  (POST /api, GET /events)`);
  });
}
