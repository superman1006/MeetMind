// 这个文件:前端「订阅服务器持续推送」的工具(SSE,单向长连,像订报纸:登记一次,之后报社一直往你家送)。
// 连接模型(B 方案):整个前端只开这一条 SSE 长连(firehose),订阅所有会话;每帧自带 sessionId,
// 上层据此把事件路由到对应会话(见 App.vue 的全局订阅)。所以这里不再按会话建连、不带 sessionId 入参。
import { logger } from "./logger.js";

// 每个事件 payload 都带 sessionId:服务端在 sseServer.send 里把 sessionId 拼进了帧体,前端据此判断属于哪个会话。
// turn_start:某个 Agent 开始发言。turnId=本次发言编号,agent_name/role=是谁。
export interface TurnStartPayload { sessionId: string; turnId: string; agent_name: string; role: string }
// delta:一小段新蹦出来的文字(打字机效果就靠它一段段拼起来)。
export interface DeltaPayload { sessionId: string; turnId: string; text: string }
// using_tools:这个 Agent 正在调某个工具(如 rag_search / web_search)。
export interface UsingToolsPayload { sessionId: string; turnId: string; tool: string }
// tool_result:某次工具调用执行完成,带上这次调用的工具名 / 入参 / 返回结果(前端据此加按钮 + 展开结果)。
export interface ToolResultPayload { sessionId: string; turnId: string; name: string; args: Record<string, unknown>; result: string }
// turn_end:某个 Agent 发言结束。next_agent=接下来轮到谁,done=整轮是否到此为止。
export interface TurnEndPayload { sessionId: string; turnId: string; next_agent: string | null; done: boolean; used_rag: boolean }
// round_done:一整轮讨论彻底结束。
export interface RoundDonePayload { sessionId: string; done: boolean }
// error:服务器侧出错,把错误信息推过来给前端显示。
export interface ErrorPayload { sessionId: string; message: string; turnId?: string }
// summary_done:会议纪要整理完成,file=生成的 markdown 文件路径。
export interface SummaryDonePayload { sessionId: string; file: string }
// summary_error:整理纪要过程出错。
export interface SummaryErrorPayload { sessionId: string; message: string }

// 一组回调:每种事件来时分别调哪个函数处理(由界面/状态层传进来)。
export interface SseHandlers {
  onTurnStart: (p: TurnStartPayload) => void;
  onDelta: (p: DeltaPayload) => void;
  onUsingTools: (p: UsingToolsPayload) => void;
  onToolResult: (p: ToolResultPayload) => void;
  onTurnEnd: (p: TurnEndPayload) => void;
  onRoundDone: (p: RoundDonePayload) => void;
  onError: (p: ErrorPayload) => void;
  onSummaryDone: (p: SummaryDonePayload) => void;
  onSummaryError: (p: SummaryErrorPayload) => void;
}

// 订阅全局事件流(所有会话共用这一条),返回连接对象(调用方可随时 es.close() 断开)。
export function openEvents(handlers: SseHandlers): EventSource {
  const url = "/events";

  // 打印「发出的 SSE 订阅请求」:URL + HTTP 方法。
  logger.info({ url, httpMethod: "GET" }, "→ 订阅事件流");

  // new EventSource = 连上去并开始持续接收,从这一刻起连接一直开着、断了会自动重连。
  // 返回的 es 就是连接对象,上面可以注册各种事件回调(onopen/onerror/addEventListener),也可以随时 es.close() 断开连接。
  const es = new EventSource(url);

  // 连接就绪 / 连接层出错只记一行,逐条 delta 太碎不打日志。
  es.onopen = () => {
    logger.info({ url }, "← 事件流已连接");
  };


  // 下面这些 回调函数 后面会被 后端 推来的事件触发(根据类型)
  // 下面每个 addEventListener("类型名", ...) = “收到这类事件时怎么办”;
  // e.data 是服务器推来的 JSON 字符串,先 parse 还原成对象(含 sessionId),再转交给上层 handler。
  es.addEventListener("turn_start", (e) => {
    handlers.onTurnStart(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("delta", (e) => {
    handlers.onDelta(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("using_tools", (e) => {
    handlers.onUsingTools(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("tool_result", (e) => {
    handlers.onToolResult(JSON.parse((e as MessageEvent).data));
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
      logger.error({ url, payload }, "← 事件流业务错误");
      handlers.onError(payload);
    }
  });

  es.addEventListener("summary_done", (e) => {
    handlers.onSummaryDone(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("summary_error", (e) => {
    handlers.onSummaryError(JSON.parse((e as MessageEvent).data));
  });

  return es;
}
