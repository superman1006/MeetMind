// 这个文件:前端「订阅服务器持续推送」的工具(SSE,单向长连,像订报纸:登记一次,之后报社一直往你家送)。
import { logger } from "./logger.js";

// turn_start:某个 Agent 开始发言。turnId=本次发言编号,agent_name/role=是谁。
export interface TurnStartPayload { turnId: string; agent_name: string; role: string }
// delta:一小段新蹦出来的文字(打字机效果就靠它一段段拼起来)。
export interface DeltaPayload { turnId: string; text: string }
// using_tools:这个 Agent 正在调某个工具(如 rag_search / web_search)。
export interface UsingToolsPayload { turnId: string; tool: string }
// turn_end:某个 Agent 发言结束。next_agent=接下来轮到谁,done=整轮是否到此为止。
export interface TurnEndPayload { turnId: string; next_agent: string | null; done: boolean; used_rag: boolean }
// round_done:一整轮讨论彻底结束。
export interface RoundDonePayload { done: boolean }
// error:服务器侧出错,把错误信息推过来给前端显示。
export interface ErrorPayload { message: string; turnId?: string }

// 一组回调:每种事件来时分别调哪个函数处理(由界面/状态层传进来)。
export interface SseHandlers {
  onTurnStart: (p: TurnStartPayload) => void;
  onDelta: (p: DeltaPayload) => void;
  onUsingTools: (p: UsingToolsPayload) => void;
  onTurnEnd: (p: TurnEndPayload) => void;
  onRoundDone: (p: RoundDonePayload) => void;
  onError: (p: ErrorPayload) => void;
}

// 订阅某个会话的事件流,返回连接对象(调用方可随时 es.close() 断开)。
export function openEvents(sessionId: string, handlers: SseHandlers): EventSource {
  // 把要订阅哪个会话拼进网址;encodeURIComponent 把特殊字符转义,避免网址出错。
  const url = `/events?sessionId=${encodeURIComponent(sessionId)}`;

  // 打印「发出的 SSE 订阅请求」:URL + HTTP 方法 + 会话 id。
  logger.info({ url, httpMethod: "GET", sessionId }, "→ 订阅事件流");

  // new EventSource = 连上去并开始持续接收,从这一刻起连接一直开着、断了会自动重连。
  const es = new EventSource(url);

  // 连接就绪 / 连接层出错只记一行,逐条 delta 太碎不打日志。
  es.onopen = () => {
    logger.info({ url, sessionId }, "← 事件流已连接");
  };

  // 下面每个 addEventListener("类型名", ...) = “收到这类事件时怎么办”;
  // e.data 是服务器推来的 JSON 字符串,先 parse 还原成对象,再转交给上层 handler。
  es.addEventListener("turn_start", (e) => {
    handlers.onTurnStart(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("delta", (e) => {
    handlers.onDelta(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("using_tools", (e) => {
    handlers.onUsingTools(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("turn_end", (e) => {
    handlers.onTurnEnd(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("round_done", (e) => {
    handlers.onRoundDone(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("error", (e) => {
    const me = e as MessageEvent;
    // EventSource 在“网络断了”时也会触发 error,但那种没有 data;只有服务器主动推的业务错误才带 data,这里只处理后者。
    if (me.data) {
      const payload = JSON.parse(me.data);
      logger.error({ url, sessionId, payload }, "← 事件流业务错误");
      handlers.onError(payload);
    }
  });

  return es;
}
