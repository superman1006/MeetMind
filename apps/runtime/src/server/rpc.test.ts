import { describe, it, expect, beforeEach } from "vitest";
import { handleRpc } from "./rpc.js";
import * as sessions from "./sessions.js";
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
    sessions.resetSession("s1");
    sessions.setBusy("s1", false);
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

  it("缺参数返回 -32602", async () => {
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

  it("session.reset 清空记忆", async () => {
    const res = await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 4,
      method: "session.reset",
      params: { sessionId: "s1" },
    });
    expect(res).toMatchObject({ result: { ok: true } });
  });

  it("未知方法返回 -32601", async () => {
    const res = (await handleRpc(fakeGraph, {
      jsonrpc: "2.0",
      id: 5,
      method: "nope",
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32601);
  });
});
