/**
 * 会话运行时状态:busy 标记(同会话串行,内存即可,重启可重置)。
 * 消息 / 跨轮记忆已搬到 PostgreSQL,见 database/chatStore.ts。
 */
const busySessions = new Set<string>();

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
