import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

// 假 EventSource:记录 addEventListener 注册的回调,测试里手动派发事件。
class FakeEventSource {
  url: string;
  onopen: (() => void) | null = null;
  listeners: Record<string, (e: { data?: string }) => void> = {};
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, cb: (e: { data?: string }) => void): void {
    this.listeners[type] = cb;
  }
  close(): void {
    // no-op
  }
}

import { openEvents, type SseHandlers } from "./sseClient.js";

function makeHandlers(): SseHandlers {
  return {
    onTurnStart: vi.fn(),
    onDelta: vi.fn(),
    onUsingTools: vi.fn(),
    onToolResult: vi.fn(),
    onToolApprovalRequest: vi.fn(),
    onTurnEnd: vi.fn(),
    onRoundDone: vi.fn(),
    onError: vi.fn(),
    onSummaryDone: vi.fn(),
    onSummaryError: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sseClient.openEvents", () => {
  it("订阅固定的 /events(firehose,不带 sessionId)", () => {
    const es = openEvents(makeHandlers()) as unknown as FakeEventSource;
    expect(es.url).toBe("/events");
  });

  it("各业务事件 JSON.parse 后(含 sessionId)转交对应 handler", () => {
    const h = makeHandlers();
    const es = openEvents(h) as unknown as FakeEventSource;

    es.listeners["turn_start"]({ data: JSON.stringify({ sessionId: "s1", turnId: "t1", agent_name: "backend", role: "后端" }) });
    expect(h.onTurnStart).toHaveBeenCalledWith({ sessionId: "s1", turnId: "t1", agent_name: "backend", role: "后端" });

    es.listeners["delta"]({ data: JSON.stringify({ sessionId: "s1", turnId: "t1", text: "嗨" }) });
    expect(h.onDelta).toHaveBeenCalledWith({ sessionId: "s1", turnId: "t1", text: "嗨" });

    es.listeners["using_tools"]({ data: JSON.stringify({ sessionId: "s1", turnId: "t1", tool: "rag_search" }) });
    expect(h.onUsingTools).toHaveBeenCalledWith({ sessionId: "s1", turnId: "t1", tool: "rag_search" });

    es.listeners["turn_end"]({ data: JSON.stringify({ sessionId: "s1", turnId: "t1", next_agent: "architect", done: false, used_rag: true }) });
    expect(h.onTurnEnd).toHaveBeenCalledWith({ sessionId: "s1", turnId: "t1", next_agent: "architect", done: false, used_rag: true });

    es.listeners["round_done"]({ data: JSON.stringify({ sessionId: "s1", done: true }) });
    expect(h.onRoundDone).toHaveBeenCalledWith({ sessionId: "s1", done: true });

    es.listeners["summary_done"]({ data: JSON.stringify({ sessionId: "s1", file: "/x.md" }) });
    expect(h.onSummaryDone).toHaveBeenCalledWith({ sessionId: "s1", file: "/x.md" });

    es.listeners["summary_error"]({ data: JSON.stringify({ sessionId: "s1", message: "整理失败" }) });
    expect(h.onSummaryError).toHaveBeenCalledWith({ sessionId: "s1", message: "整理失败" });
  });

  it("error 事件:带 data 才回调 onError;无 data(连接层断开)不回调", () => {
    const h = makeHandlers();
    const es = openEvents(h) as unknown as FakeEventSource;
    es.listeners["error"]({ data: undefined }); // 网络断 → 不回调
    expect(h.onError).not.toHaveBeenCalled();
    es.listeners["error"]({ data: JSON.stringify({ sessionId: "s1", message: "服务器错" }) }); // 业务错 → 回调
    expect(h.onError).toHaveBeenCalledWith({ sessionId: "s1", message: "服务器错" });
  });

  it("onopen 被设置且可执行(连接就绪日志分支)", () => {
    const es = openEvents(makeHandlers()) as unknown as FakeEventSource;
    expect(typeof es.onopen).toBe("function");
    es.onopen?.();
  });
});
