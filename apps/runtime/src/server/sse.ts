// 这个文件:后端「保管所有 SSE 长连接、并往里推消息」的地方。
// httpServer 开好长连后调 addClient 把它存进来;讨论过程中业务代码调 send(...) 就能推给订阅了该会话的前端。
import type { ServerResponse } from "node:http";

// 通讯录:会话 id → 该会话当前所有打开的 SSE 连接(同一会话可能多开窗口,所以用 Set 存多条)。
const clientsBySession = new Map<string, Set<ServerResponse>>();

// 登记一条新的 SSE 连接到某会话;该会话还没有任何连接时先建一个空 Set。
export function addClient(sessionId: string, res: ServerResponse): void {
  let set = clientsBySession.get(sessionId);
  if (!set) {
    set = new Set<ServerResponse>();
    clientsBySession.set(sessionId, set);
  }
  set.add(res);
}

// 连接关闭时把它移除;移除后这个会话一条连接都不剩了,就顺手删掉整个会话条目,别让通讯录越积越大。
export function removeClient(sessionId: string, res: ServerResponse): void {
  const set = clientsBySession.get(sessionId);
  if (!set) {
    return;
  }
  set.delete(res);
  if (set.size === 0) {
    clientsBySession.delete(sessionId);
  }
}

// 往某会话的所有连接推一条 SSE 事件(服务器主动推送的核心动作);该会话没人订阅时静默忽略、不报错。
export function send(sessionId: string, event: string, data: unknown): void {
  const set = clientsBySession.get(sessionId);
  if (!set) {
    return;
  }
  // 按 SSE 固定文本格式拼这一帧:event 行 + data 行(数据序列化成 JSON)+ 一个空行表示这条结束。
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  // 写给该会话的每一条连接。
  for (const res of set) {
    res.write(payload);
  }
}
