import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleRpc } from "./rpc.js";
import * as sessions from "./sessions.js";
import * as chatStore from "../database/chatStore.js";
import type { buildGraph } from "../graph/builder.js";

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
    // 把所有 DB 调用打桩,避免单测连真库
    vi.spyOn(chatStore, "getMessages").mockResolvedValue([]);
    vi.spyOn(chatStore, "appendMessages").mockResolvedValue(undefined);
    vi.spyOn(chatStore, "createSession").mockResolvedValue({
      id: "new-id",
      title: "新会话",
      created_at: "2026-06-01T00:00:00Z",
    });
    vi.spyOn(chatStore, "listSessions").mockResolvedValue([
      { id: "a", title: "会话A", created_at: "2026-06-01T00:00:00Z" },
    ]);
    vi.spyOn(chatStore, "deleteSession").mockResolvedValue(undefined);
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

  it("未知方法返回 -32601", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 9,
      method: "nope",
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32601);
  });
});
