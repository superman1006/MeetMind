import { describe, it, expect, vi, beforeEach } from "vitest";

// 只验证清理函数拼的 SQL；pg 池打桩，不连真库、不实例化 PostgresSaver。
const mockQuery = vi.hoisted(() => vi.fn());
vi.mock("../../database/connection/client.js", () => ({
  getPgPool: () => ({ query: mockQuery }),
}));
vi.mock("../../config/settings.js", () => ({
  getSettings: () => ({ pgUrl: "postgresql://x/y", logLevel: "info" }),
}));

import { deleteThreadCheckpoints } from "../checkpointer.js";

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("deleteThreadCheckpoints", () => {
  it("对三张 checkpoint 表各发一条按 thread_id 的 DELETE", async () => {
    await deleteThreadCheckpoints("s1:r1");
    expect(mockQuery).toHaveBeenCalledTimes(3);
    const joined = mockQuery.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("DELETE FROM checkpoints WHERE thread_id = $1");
    expect(joined).toContain("DELETE FROM checkpoint_blobs WHERE thread_id = $1");
    expect(joined).toContain("DELETE FROM checkpoint_writes WHERE thread_id = $1");
    for (const call of mockQuery.mock.calls) {
      expect(call[1]).toEqual(["s1:r1"]);
    }
  });

  it("某条 DELETE 抛错时吞掉异常、不向上抛，且不连累其余表的清理", async () => {
    // 第一张表 DELETE 失败，其余两张应照常尝试（共 3 次调用），整体不抛。
    mockQuery.mockRejectedValueOnce(new Error("boom"));
    await expect(deleteThreadCheckpoints("s1:r1")).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});
