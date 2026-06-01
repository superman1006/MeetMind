import { describe, it, expect } from "vitest";
import { addClient, removeClient, send } from "./sse.js";
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

describe("sse", () => {
  it("send 把 event/data 按 SSE 帧写给该会话的所有连接", () => {
    const a = fakeRes();
    const b = fakeRes();
    addClient("s1", a.res);
    addClient("s1", b.res);
    send("s1", "delta", { turnId: "architect-1", text: "你好" });
    const expected = `event: delta\ndata: ${JSON.stringify({ turnId: "architect-1", text: "你好" })}\n\n`;
    expect(a.writes).toEqual([expected]);
    expect(b.writes).toEqual([expected]);
  });

  it("移除连接后不再收到", () => {
    const a = fakeRes();
    addClient("s2", a.res);
    removeClient("s2", a.res);
    send("s2", "round_done", { done: true });
    expect(a.writes).toEqual([]);
  });

  it("未知会话 send 不抛错", () => {
    expect(() => send("ghost", "delta", { x: 1 })).not.toThrow();
  });
});
