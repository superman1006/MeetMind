import { describe, it, expect, vi, beforeEach } from "vitest";

// 数据层单测:把 pg 连接池打桩,只验证 userStore 拼的 SQL 与返回映射,不连真库。
// mockQuery 用 vi.hoisted 提前声明,好在 vi.mock 工厂里引用(vi.mock 会被提升到文件顶部)。
const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("../../connection/client.js", () => ({
  getPgPool: () => ({ query: mockQuery }),
}));
// 固定表前缀,断言表名时不受 .env 影响。
vi.mock("../../../config/settings.js", () => ({
  getSettings: () => ({ pgTablePrefix: "meetmind" }),
}));

import { createUser, verifyUser, getMemory, setMemory } from "../userStore.js";

beforeEach(() => {
  mockQuery.mockReset();
  // 默认空结果;需要具体行的用例各自 mockResolvedValueOnce 覆盖。
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("createUser", () => {
  it("新用户:INSERT ... ON CONFLICT DO NOTHING RETURNING 命中行 → ok:true", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "7" }], rowCount: 1 });
    const result = await createUser("alice", "pw123");
    expect(result).toEqual({ ok: true });

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO meetmind_user");
    expect(sql).toContain("ON CONFLICT (username) DO NOTHING");
    expect(sql).toContain("RETURNING");
    // 正文走 $n 占位符,不内插。
    expect(mockQuery.mock.calls[0][1]).toEqual(["alice", "pw123"]);
  });

  it("用户名已存在:INSERT 无返回行 → ok:false reason:exists", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await createUser("admin", "whatever");
    expect(result).toEqual({ ok: false, reason: "exists" });
  });
});

describe("verifyUser", () => {
  it("命中:回 ok:true + username", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ username: "admin" }], rowCount: 1 });
    const result = await verifyUser("admin", "admin");
    expect(result).toEqual({ ok: true, username: "admin" });
  });

  it("未命中:回 ok:false", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await verifyUser("admin", "wrong");
    expect(result).toEqual({ ok: false });
  });
});

describe("getMemory", () => {
  it("命中:回该行 memory,SQL 按 username 查、走 $1 占位符", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ memory: "我喜欢简洁的设计" }], rowCount: 1 });
    const memory = await getMemory("alice");
    expect(memory).toBe("我喜欢简洁的设计");

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("SELECT memory FROM meetmind_user");
    expect(sql).toContain("WHERE username = $1");
    expect(mockQuery.mock.calls[0][1]).toEqual(["alice"]);
  });

  it("memory 列为 NULL → 回空串", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ memory: null }], rowCount: 1 });
    const memory = await getMemory("alice");
    expect(memory).toBe("");
  });

  it("用户不存在(无返回行) → 回空串", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const memory = await getMemory("ghost");
    expect(memory).toBe("");
  });
});

describe("setMemory", () => {
  it("UPDATE memory,按 username 定位,正文走 $n 占位符", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await setMemory("alice", "新的记忆");

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("UPDATE meetmind_user SET memory = $2");
    expect(sql).toContain("WHERE username = $1");
    expect(mockQuery.mock.calls[0][1]).toEqual(["alice", "新的记忆"]);
  });

  it("空串合法(清空记忆)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await setMemory("alice", "");
    expect(mockQuery.mock.calls[0][1]).toEqual(["alice", ""]);
  });
});
