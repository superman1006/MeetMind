import { describe, it, expect, vi, beforeEach } from "vitest";

// 数据层单测：把 pg 连接池和建表辅助函数打桩，只验证 SQL 与参数，不连真库。
const mockQuery = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn());

vi.mock("../../connection/client.js", () => ({
  getPgPool: () => ({ query: mockQuery, connect: mockConnect }),
  ensureAgentTable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../config/settings.js", () => ({
  getSettings: () => ({ pgTablePrefix: "meetmind" }),
}));

import { applyDefaultCapabilities, registerTwin } from "../twins.js";

beforeEach(() => {
  mockQuery.mockReset();
  mockConnect.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("registerTwin", () => {
  it("创建账号时写入全部默认工具与技能", async () => {
    const clientQuery = vi.fn();
    clientQuery.mockResolvedValue({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
    clientQuery.mockResolvedValueOnce({ rows: [{ id: "7" }] }); // INSERT ... RETURNING id
    mockConnect.mockResolvedValue({ query: clientQuery, release: vi.fn() });

    const ok = await registerTwin(
      "alice", "pw123", "Alice", "", ["rag_search", "echo"], ["code-review"],
    );
    expect(ok).toBe(true);

    let insertCall: unknown[] | undefined;
    for (const call of clientQuery.mock.calls) {
      const sql = String(call[0]);
      if (sql.includes("INSERT INTO meetmind_user")) {
        insertCall = call;
        break;
      }
    }
    expect(insertCall).toBeDefined();
    expect(insertCall?.[1]).toEqual([
      "alice",
      expect.stringMatching(/^scrypt:/),
      "Alice",
      "",
      JSON.stringify(["rag_search", "echo"]),
      JSON.stringify(["code-review"]),
    ]);
  });

  it("与内置角色重名时直接拒绝，不写库", async () => {
    const ok = await registerTwin("architect", "pw123", "", "", [], []);
    expect(ok).toBe(false);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe("applyDefaultCapabilities", () => {
  it("只更新仍停留在历史默认值的账号", async () => {
    await applyDefaultCapabilities("admin", ["rag_search", "echo"], ["code-review"]);

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("UPDATE meetmind_user SET tools = $2, skills = $3");
    expect(sql).toContain("skills = '[]'::jsonb");
    expect(sql).toContain("tools IN ($4::jsonb, $5::jsonb)");
    expect(mockQuery.mock.calls[0][1]).toEqual([
      "admin",
      JSON.stringify(["rag_search", "echo"]),
      JSON.stringify(["code-review"]),
      JSON.stringify(["rag_search"]),
      JSON.stringify(["rag_search", "Read", "list_dir", "glob", "grep"]),
    ]);
  });
});
