/** 连 /events 的 SSE,把各事件交给 handlers。事件结构与 runtime 的 NodeStreamChunk + round_done/error 对齐。 */
export interface TurnStartPayload { turnId: string; agent_name: string; role: string }
export interface DeltaPayload { turnId: string; text: string }
export interface TurnEndPayload { turnId: string; next_agent: string | null; done: boolean; used_rag: boolean }
export interface RoundDonePayload { done: boolean }
export interface ErrorPayload { message: string; turnId?: string }

export interface SseHandlers {
  onTurnStart: (p: TurnStartPayload) => void;
  onDelta: (p: DeltaPayload) => void;
  onTurnEnd: (p: TurnEndPayload) => void;
  onRoundDone: (p: RoundDonePayload) => void;
  onError: (p: ErrorPayload) => void;
}

export function openEvents(sessionId: string, handlers: SseHandlers): EventSource {
  const url = `/events?sessionId=${encodeURIComponent(sessionId)}`;
  const es = new EventSource(url);

  es.addEventListener("turn_start", (e) => {
    handlers.onTurnStart(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("delta", (e) => {
    handlers.onDelta(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("turn_end", (e) => {
    handlers.onTurnEnd(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("round_done", (e) => {
    handlers.onRoundDone(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("error", (e) => {
    const me = e as MessageEvent;
    // 网络层断线 EventSource 也会触发 error 但无 data;只处理服务端业务 error
    if (me.data) {
      handlers.onError(JSON.parse(me.data));
    }
  });

  return es;
}
