import { describe, it, expect } from "vitest";
import { addClient, removeClient, send } from "./sseServer.js";
import type { ServerResponse } from "node:http";

/** 造一个只捕获 write 内容的假 ServerResponse。 */
function fakeRes() {
  const writes: string[] = [];
  const res = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as ServerResponse;
  return { res, writes };
}

describe("sseServer", () => {
  it("send 把 sessionId 拼进帧体, 按 SSE 帧广播给所有连接", () => {
    const a = fakeRes();
    const b = fakeRes();
    addClient(a.res);
    addClient(b.res);
    send("s1", "delta", { turnId: "architect-1", text: "你好" });
    const expected = `event: delta\ndata: ${JSON.stringify({ sessionId: "s1", turnId: "architect-1", text: "你好" })}\n\n`;
    expect(a.writes).toEqual([expected]);
    expect(b.writes).toEqual([expected]);
    removeClient(a.res);
    removeClient(b.res);
  });

  it("不同会话的事件都走同一批连接, 各帧带各自的 sessionId", () => {
    const a = fakeRes();
    addClient(a.res);
    send("s1", "delta", { turnId: "t1", text: "甲" });
    send("s2", "delta", { turnId: "t2", text: "乙" });
    expect(a.writes).toEqual([
      `event: delta\ndata: ${JSON.stringify({ sessionId: "s1", turnId: "t1", text: "甲" })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ sessionId: "s2", turnId: "t2", text: "乙" })}\n\n`,
    ]);
    removeClient(a.res);
  });

  it("移除连接后不再收到", () => {
    const a = fakeRes();
    addClient(a.res);
    removeClient(a.res);
    send("s2", "round_done", { done: true });
    expect(a.writes).toEqual([]);
  });

  it("没有任何连接时 send 不抛错", () => {
    expect(() => send("ghost", "delta", { x: 1 })).not.toThrow();
  });
});
