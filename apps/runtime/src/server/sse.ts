/**
 * SSE 连接管理:按 sessionId 维护一组打开的 ServerResponse,send 把事件写成 SSE 帧。
 */
import type { ServerResponse } from "node:http";

const clientsBySession = new Map<string, Set<ServerResponse>>();

/** 登记一个 SSE 长连接到某会话。 */
export function addClient(sessionId: string, res: ServerResponse): void {
  let set = clientsBySession.get(sessionId);
  if (!set) {
    set = new Set<ServerResponse>();
    clientsBySession.set(sessionId, set);
  }
  set.add(res);
}

/** 连接关闭时移除。 */
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

/** 向某会话所有连接推一条 SSE 事件;未知会话静默忽略。 */
export function send(sessionId: string, event: string, data: unknown): void {
  const set = clientsBySession.get(sessionId);
  if (!set) {
    return;
  }
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    res.write(payload);
  }
}
