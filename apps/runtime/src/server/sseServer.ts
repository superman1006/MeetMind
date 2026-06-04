// 这个文件:后端「保管所有 SSE 长连接、并往里推消息」的地方。
// httpServer 开好长连后调 addClient 把它存进来;讨论过程中业务代码调 send(...) 就能推给前端。
//
// 连接模型(B 方案):整个前端只开一条 SSE 长连(firehose),所有会话的事件都从这一条连推下去,
// 每帧带上 sessionId,前端据此路由到对应会话。所以这里不再按 sessionId 分桶,只用一个扁平 Set 存所有连接。
import type { ServerResponse } from "node:http";

// 所有打开的 SSE 连接(不分会话);单窗口前端通常只有一条,多开窗口/标签时可能多条。
const clients = new Set<ServerResponse>();

// 登记一条新的 SSE 连接。
export function addClient(res: ServerResponse): void {
  clients.add(res);
}

// 连接关闭时把它移除,别让登记表越积越大。
export function removeClient(res: ServerResponse): void {
  clients.delete(res);
}

// 往所有连接推一条 SSE 事件(服务器主动推送的核心动作);sessionId 拼进帧体,前端据此判断这条事件属于哪个会话。
// 没有任何连接时静默忽略、不报错。
export function send(sessionId: string, event: string, data: unknown): void {
  if (clients.size === 0) {
    return;
  }
  // 把 sessionId 并进数据对象:前端 JSON.parse 后读 sessionId 路由到对应会话,其余字段照旧。
  const framed = { sessionId, ...(data as Record<string, unknown>) };
  // 按 SSE 固定文本格式拼这一帧:event 行 + data 行(数据序列化成 JSON)+ 一个空行表示这条结束。
  const payload = `event: ${event}\ndata: ${JSON.stringify(framed)}\n\n`;
  // 写给每一条连接。
  for (const res of clients) {
    res.write(payload);
  }
}
