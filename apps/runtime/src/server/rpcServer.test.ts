import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleRpc } from "./rpcServer.js";
import * as sessions from "./sessions.js";
import * as chatStore from "../database/chat/chatStore.js";
import type { buildGraph } from "../graph/builder.js";

// chat.end 会在后台调 summarizeMeeting（内部跑 LLM）。单测里 mock 成 no-op，避免真调模型。
vi.mock("./meetingSummary.js", () => ({
  summarizeMeeting: vi.fn(() => Promise.resolve()),
}));
import * as meetingSummary from "./meetingSummary.js";

// 假 graph:stream 立即结束,不产生任何事件
const fakeGraph = {
  async stream() {
    async function* gen() {
      yield ["values", { messages: [], done: true }];
    }
    return gen();
  },
} as unknown as ReturnType<typeof buildGraph>;

describe("handleRpc", () => {
  beforeEach(() => {
    sessions.setBusy("s1", false);
    sessions.clearController("s1");
    // 把所有 DB 调用打桩,避免单测连真库
    vi.spyOn(chatStore, "getMessages").mockResolvedValue([]);
    vi.spyOn(chatStore, "appendMessages").mockResolvedValue(undefined);
    vi.spyOn(chatStore, "createSession").mockResolvedValue({
      id: "new-id",
      title: "新会话",
      created_at: "2026-06-01T00:00:00Z",
      ended: false,
    });
    vi.spyOn(chatStore, "listSessions").mockResolvedValue([
      { id: "a", title: "会话A", created_at: "2026-06-01T00:00:00Z", ended: false },
    ]);
    vi.spyOn(chatStore, "deleteSession").mockResolvedValue(undefined);
    vi.spyOn(chatStore, "renameSession").mockResolvedValue(undefined);
    vi.spyOn(chatStore, "isSessionEnded").mockResolvedValue(false);
    vi.spyOn(chatStore, "markSessionEnded").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chat.send 立即返回 ok 并置 busy", async () => {
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 1,
      method: "chat.send",
      params: { sessionId: "s1", requirement: "做个登录页" },
    });
    expect(res).toMatchObject({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("chat.send 缺参数返回 -32602", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 2,
      method: "chat.send",
      params: { sessionId: "s1" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("busy 会话再发返回 -32000", async () => {
    sessions.setBusy("s1", true);
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 3,
      method: "chat.send",
      params: { sessionId: "s1", requirement: "x" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32000);
  });

  it("session.create 返回新会话元信息", async () => {
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 4,
      method: "session.create",
      params: { title: "我的会话" },
    });
    expect(res).toMatchObject({ result: { id: "new-id" } });
  });

  it("session.list 返回会话数组", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 5,
      method: "session.list",
    })) as { result?: unknown[] };
    expect(Array.isArray(res.result)).toBe(true);
    expect(res.result).toHaveLength(1);
  });

  it("session.messages 缺 sessionId 返回 -32602", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 6,
      method: "session.messages",
      params: {},
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("session.delete 成功返回 ok", async () => {
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 7,
      method: "session.delete",
      params: { sessionId: "s1" },
    });
    expect(res).toMatchObject({ result: { ok: true } });
    expect(chatStore.deleteSession).toHaveBeenCalledWith("s1");
  });

  it("session.delete busy 中拒删返回 -32000", async () => {
    sessions.setBusy("s1", true);
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 8,
      method: "session.delete",
      params: { sessionId: "s1" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32000);
  });

  it("chat.interrupt abort 掉该会话进行中的 controller", async () => {
    const controller = new AbortController();
    sessions.setController("s1", controller);
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 10,
      method: "chat.interrupt",
      params: { sessionId: "s1" },
    });
    expect(res).toMatchObject({ result: { ok: true } });
    expect(controller.signal.aborted).toBe(true);
  });

  it("chat.interrupt 无进行中讨论也返回 ok(幂等)", async () => {
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 11,
      method: "chat.interrupt",
      params: { sessionId: "s1" },
    });
    expect(res).toMatchObject({ result: { ok: true } });
  });

  it("chat.interrupt 缺 sessionId 返回 -32602", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 12,
      method: "chat.interrupt",
      params: {},
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("session.rename 成功返回 ok 并 trim 标题", async () => {
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 13,
      method: "session.rename",
      params: { sessionId: "s1", title: "  新名字  " },
    });
    expect(res).toMatchObject({ result: { ok: true } });
    expect(chatStore.renameSession).toHaveBeenCalledWith("s1", "新名字");
  });

  it("session.rename 空标题返回 -32602", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 14,
      method: "session.rename",
      params: { sessionId: "s1", title: "   " },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("chat.end 缺 sessionId 返回 -32602", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 20,
      method: "chat.end",
      params: {},
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("chat.end busy 会话返回 -32000", async () => {
    sessions.setBusy("s1", true);
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 21,
      method: "chat.end",
      params: { sessionId: "s1" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32000);
  });

  it("chat.end 空闲时上锁、后台整理、回 ok", async () => {
    vi.mocked(meetingSummary.summarizeMeeting).mockClear();
    const setBusy = vi.spyOn(sessions, "setBusy");
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 22,
      method: "chat.end",
      params: { sessionId: "s1" },
    });
    expect(res).toMatchObject({ jsonrpc: "2.0", id: 22, result: { ok: true } });
    expect(setBusy).toHaveBeenCalledWith("s1", true);
    expect(meetingSummary.summarizeMeeting).toHaveBeenCalledWith("s1");
  });

  it("chat.end 已结束会话返回 -32000,且不再整理", async () => {
    vi.mocked(meetingSummary.summarizeMeeting).mockClear();
    vi.mocked(chatStore.isSessionEnded).mockResolvedValue(true);
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 23,
      method: "chat.end",
      params: { sessionId: "s1" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32000);
    expect(meetingSummary.summarizeMeeting).not.toHaveBeenCalled();
  });

  it("chat.end 空闲未结束时持久化 markSessionEnded 并整理", async () => {
    vi.mocked(meetingSummary.summarizeMeeting).mockClear();
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 24,
      method: "chat.end",
      params: { sessionId: "s1" },
    });
    expect(res).toMatchObject({ result: { ok: true } });
    expect(chatStore.markSessionEnded).toHaveBeenCalledWith("s1");
    expect(meetingSummary.summarizeMeeting).toHaveBeenCalledWith("s1");
  });

  it("chat.send 已结束会话返回 -32000", async () => {
    vi.mocked(chatStore.isSessionEnded).mockResolvedValue(true);
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 25,
      method: "chat.send",
      params: { sessionId: "s1", requirement: "继续讨论" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32000);
  });

  it("未知方法返回 -32601", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 9,
      method: "nope",
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32601);
  });
});
