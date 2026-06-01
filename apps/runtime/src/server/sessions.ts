/**
 * 会话运行时状态:busy 标记(同会话串行,内存即可,重启可重置) + 进行中讨论的 AbortController(供打断)。
 * 消息 / 跨轮记忆已搬到 PostgreSQL,见 database/chatStore.ts。
 */
const busySessions = new Set<string>();
// 每个正在跑的会话挂一个 AbortController;chat.interrupt 据此 abort() 打断 graph.stream。
const controllersBySession = new Map<string, AbortController>();

/** 该会话是否正在跑讨论。 */
export function isBusy(sessionId: string): boolean {
  return busySessions.has(sessionId);
}

/** 置位/清位 busy 标记。 */
export function setBusy(sessionId: string, busy: boolean): void {
  if (busy) {
    busySessions.add(sessionId);
  } else {
    busySessions.delete(sessionId);
  }
}

/** 登记某会话本轮讨论的 AbortController(chat.send 时调)。 */
export function setController(sessionId: string, controller: AbortController): void {
  controllersBySession.set(sessionId, controller);
}

/** 取某会话的 AbortController;无则 undefined。 */
export function getController(sessionId: string): AbortController | undefined {
  return controllersBySession.get(sessionId);
}

/** 移除某会话的 AbortController(本轮结束时调)。 */
export function clearController(sessionId: string): void {
  controllersBySession.delete(sessionId);
}
