import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 日志打成 no-op,避免测试输出噪音。
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.hoisted(() => vi.fn());

import { rpc } from "./rpcClient.js";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 造一个最小 Response:只用到 status 和 json()。
function fakeRes(body: unknown, status = 200): Response {
  return { status, json: async () => body } as unknown as Response;
}

describe("rpcClient.rpc", () => {
  it("成功:POST /api 发 JSON-RPC 信封,返回 result", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    const out = await rpc("chat.send", { sessionId: "s1" });
    expect(out).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith("/api", expect.objectContaining({ method: "POST" }));
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toMatchObject({ jsonrpc: "2.0", method: "chat.send", params: { sessionId: "s1" } });
  });

  it("响应带 error 字段 → 抛错(用 error.message)", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ error: { code: -32000, message: "会议已结束" } }));
    await expect(rpc("chat.end", { sessionId: "s1" })).rejects.toThrow("会议已结束");
  });

  it("error 缺 message → 抛默认文案", async () => {
    fetchMock.mockResolvedValueOnce(fakeRes({ error: {} }));
    await expect(rpc("x", {})).rejects.toThrow("RPC 出错");
  });

  it("请求 id 逐次递增", async () => {
    fetchMock.mockResolvedValue(fakeRes({ result: 1 }));
    await rpc("a", {});
    await rpc("b", {});
    const id1 = JSON.parse(fetchMock.mock.calls[0][1].body).id;
    const id2 = JSON.parse(fetchMock.mock.calls[1][1].body).id;
    expect(id2).toBe(id1 + 1);
  });
});
