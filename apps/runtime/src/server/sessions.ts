/**
 * 内存会话表：按 sessionId 存累计的 messages(跨轮记忆) + busy 标记(同会话串行)。
 * 无持久化:进程重启即丢(符合 demo 需求)。
 */
import type { AgentResponse } from "../agents/base.js";

const messagesBySession = new Map<string, AgentResponse[]>();
const busySessions = new Set<string>();

/** 取某会话累计的发言历史；未知会话返回空数组。 */
export function getMessages(sessionId: string): AgentResponse[] {
  const existing = messagesBySession.get(sessionId);
  if (existing) {
    return existing;
  }
  return [];
}

/** 用一轮结束后的全量 messages 覆盖回会话记忆。 */
export function replaceMessages(sessionId: string, messages: AgentResponse[]): void {
  messagesBySession.set(sessionId, messages);
}

/** 清空某会话记忆。 */
export function resetSession(sessionId: string): void {
  messagesBySession.delete(sessionId);
}

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
