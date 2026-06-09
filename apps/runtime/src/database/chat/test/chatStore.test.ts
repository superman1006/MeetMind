import { describe, it, expect, vi, beforeEach } from "vitest";

// 数据层单测:把 pg 连接池打桩,只验证 chatStore 拼的 SQL 与返回映射,不连真库。
// mockQuery 用 vi.hoisted 提前声明,好在 vi.mock 工厂里引用(vi.mock 会被提升到文件顶部)。
const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("../../connection/client.js", () => ({
  getPgPool: () => ({ query: mockQuery }),
}));
// 固定表前缀,断言表名时不受 .env 影响。
vi.mock("../../../config/settings.js", () => ({
  getSettings: () => ({ pgTablePrefix: "meetmind" }),
}));

import {
  ensureChatTables,
  createSession,
  listSessions,
  getSessionOwner,
  getMessages,
  appendMessages,
  renameSession,
  deleteSession,
  markSessionEnded,
  isSessionEnded,
  setPendingThread,
  clearPendingThread,
  getPendingThread,
} from "../chatStore.js";

beforeEach(() => {
  mockQuery.mockReset();
  // 默认空结果;需要具体行的用例各自 mockResolvedValueOnce 覆盖。
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("ensureChatTables", () => {
  it("建 sessions/messages 两表,并幂等补 ended / tool 列", async () => {
    await ensureChatTables();
    const sqls: string[] = [];
    for (const call of mockQuery.mock.calls) {
      sqls.push(String(call[0]));
    }
    const joined = sqls.join("\n");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS meetmind_sessions");
    expect(joined).toContain("ended BOOLEAN NOT NULL DEFAULT false");
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS ended");
    // owner 列:建表带 NOT NULL,旧表迁移先补 DEFAULT 'admin' 再 DROP DEFAULT
    expect(joined).toContain("owner TEXT NOT NULL");
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'admin'");
    expect(joined).toContain("ALTER COLUMN owner DROP DEFAULT");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS meetmind_messages");
  });
});

describe("createSession", () => {
  it("INSERT 进 sessions 并回 meta(ended 恒 false)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "uuid-1", title: "我的会话", created_at: new Date("2026-06-01T00:00:00Z") }],
    });
    const meta = await createSession("我的会话", "alice");
    expect(meta.id).toBe("uuid-1");
    expect(meta.title).toBe("我的会话");
    expect(typeof meta.created_at).toBe("string");
    expect(meta.ended).toBe(false);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO meetmind_sessions");
    expect(String(sql)).toContain("owner");
    // 参数是 [生成的 uuid, title, owner]
    expect(params[1]).toBe("我的会话");
    expect(params[2]).toBe("alice");
  });
});

describe("listSessions", () => {
  it("按 owner 过滤、created_at 倒序查,ended 转成 boolean", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "a", title: "A", created_at: new Date(), ended: true },
        { id: "b", title: "B", created_at: new Date(), ended: false },
      ],
    });
    const list = await listSessions("alice");
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: "a", title: "A", ended: true });
    expect(list[1].ended).toBe(false);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("WHERE owner = $1");
    expect(String(sql)).toContain("ORDER BY created_at DESC");
    expect(params).toEqual(["alice"]);
  });
});

describe("getSessionOwner", () => {
  it("命中:按 id 查 owner,回 owner 用户名", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ owner: "alice" }], rowCount: 1 });
    const owner = await getSessionOwner("s1");
    expect(owner).toBe("alice");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("SELECT owner FROM meetmind_sessions");
    expect(String(sql)).toContain("WHERE id = $1");
    expect(params).toEqual(["s1"]);
  });

  it("未知会话(无返回行) → 回空串", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const owner = await getSessionOwner("ghost");
    expect(owner).toBe("");
  });
});

describe("getMessages", () => {
  it("按 seq 升序查并映射成 AgentResponse", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          agent_name: "architect",
          role: "架构师",
          message: "开工",
          next_agent: "backend",
          done: false,
          used_rag: false,
          tool: "",
          created_at: new Date(),
        },
      ],
    });
    const msgs = await getMessages("s1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ agent_name: "architect", message: "开工", next_agent: "backend" });
    expect(typeof msgs[0].created_at).toBe("string");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("ORDER BY seq ASC");
    expect(params).toEqual(["s1"]);
  });
});

describe("appendMessages", () => {
  it("空数组直接返回,不查库", async () => {
    await appendMessages("s1", []);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("接着已有最大 seq 往后递增插入", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ max_seq: 4 }] }); // 查到 max=4 → 下一条从 5 起
    const turns = [
      { agent_name: "architect", role: "架构师", message: "m1", next_agent: "backend", done: false, used_rag: false, tool: "" },
      { agent_name: "backend", role: "后端", message: "m2", next_agent: "architect", done: false, used_rag: true, tool: "rag_search" },
    ];
    await appendMessages("s1", turns);
    expect(mockQuery).toHaveBeenCalledTimes(3); // 1 次 max + 2 次 insert
    // 每次 insert 的 params:[sessionId, seq, ...];seq 在索引 1
    expect(mockQuery.mock.calls[1][1][1]).toBe(5);
    expect(mockQuery.mock.calls[2][1][1]).toBe(6);
  });

  it("空会话 max(seq) 兜底 -1 → 从 0 开始", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ max_seq: -1 }] });
    await appendMessages("s1", [
      { agent_name: "a", role: "r", message: "m", next_agent: null, done: false, used_rag: false, tool: "" },
    ]);
    expect(mockQuery.mock.calls[1][1][1]).toBe(0);
  });
});

describe("renameSession / deleteSession", () => {
  it("renameSession 发 UPDATE title", async () => {
    await renameSession("s1", "新名");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("UPDATE meetmind_sessions SET title");
    expect(params).toEqual(["s1", "新名"]);
  });

  it("deleteSession 发 DELETE", async () => {
    await deleteSession("s1");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("DELETE FROM meetmind_sessions");
    expect(params).toEqual(["s1"]);
  });
});

describe("markSessionEnded / isSessionEnded", () => {
  it("markSessionEnded 发 UPDATE ended=true", async () => {
    await markSessionEnded("s1");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("SET ended = true");
    expect(params).toEqual(["s1"]);
  });

  it("isSessionEnded:ended=true 行 → true", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ended: true }] });
    expect(await isSessionEnded("s1")).toBe(true);
  });

  it("isSessionEnded:ended=false 行 → false", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ended: false }] });
    expect(await isSessionEnded("s1")).toBe(false);
  });

  it("isSessionEnded:无此会话(空行)→ false", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await isSessionEnded("nope")).toBe(false);
  });
});

describe("pending_thread_id（断点续跑标记）", () => {
  it("ensureChatTables 幂等补 pending_thread_id 列", async () => {
    await ensureChatTables();
    const sqls: string[] = [];
    for (const call of mockQuery.mock.calls) {
      sqls.push(String(call[0]));
    }
    const joined = sqls.join("\n");
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS pending_thread_id TEXT");
  });

  it("setPendingThread 发 UPDATE 写入 thread_id", async () => {
    await setPendingThread("s1", "s1:r1");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("UPDATE meetmind_sessions SET pending_thread_id = $2");
    expect(String(sql)).toContain("WHERE id = $1");
    expect(params).toEqual(["s1", "s1:r1"]);
  });

  it("clearPendingThread 发 UPDATE 置 NULL", async () => {
    await clearPendingThread("s1");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("SET pending_thread_id = NULL");
    expect(params).toEqual(["s1"]);
  });

  it("getPendingThread 命中时回 thread_id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ pending_thread_id: "s1:r1" }] });
    expect(await getPendingThread("s1")).toBe("s1:r1");
  });

  it("getPendingThread 无行 / 为 NULL → 回 null", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getPendingThread("ghost")).toBe(null);
    mockQuery.mockResolvedValueOnce({ rows: [{ pending_thread_id: null }] });
    expect(await getPendingThread("s2")).toBe(null);
  });
});
