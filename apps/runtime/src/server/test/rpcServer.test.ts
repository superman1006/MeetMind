import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleRpc } from "../rpcServer.js";
import * as sessions from "../sessions.js";
import * as chatStore from "../../database/chat/chatStore.js";
import * as userStore from "../../database/users/userStore.js";
import type { buildGraph } from "../../graph/builder.js";

// chat.end 会在后台调 summarizeMeeting（内部跑 LLM）。单测里 mock 成 no-op，避免真调模型。
vi.mock("../meetingSummary.js", () => ({
  summarizeMeeting: vi.fn(() => Promise.resolve()),
}));
import * as meetingSummary from "../meetingSummary.js";

// model.set 会调真 buildGraph（构造全部 agent）。单测里 mock 成轻量假 graph，避免加载模型/检索器。
vi.mock("../../graph/builder.js", () => ({
  buildGraph: vi.fn(() => ({ stream: () => undefined })),
}));
import * as builder from "../../graph/builder.js";

// chat.summaryTitle 会调 summarizeTitle（内部跑 LLM）。单测里 mock 成可控返回，避免真调模型。
vi.mock("../titleSummary.js", () => ({
  summarizeTitle: vi.fn(() => Promise.resolve("登录页设计")),
}));
import * as titleSummary from "../titleSummary.js";

// 假 graph:stream 立即结束,不产生任何事件
const fakeGraph = {
  async stream() {
    async function* gen() {
      yield ["values", { messages: [], done: true }];
    }
    return gen();
  },
} as unknown as ReturnType<typeof buildGraph>;

// handleRpc 现在收 GraphHolder（可变持有者），单测里包一层即可。
const graphHolder = { current: fakeGraph };

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
    const res = await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 1,
      method: "chat.send",
      params: { sessionId: "s1", requirement: "做个登录页" },
    });
    expect(res).toMatchObject({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("chat.send 缺参数返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 2,
      method: "chat.send",
      params: { sessionId: "s1" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("busy 会话再发返回 -32000", async () => {
    sessions.setBusy("s1", true);
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 3,
      method: "chat.send",
      params: { sessionId: "s1", requirement: "x" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32000);
  });

  it("session.create 带 username 返回新会话元信息", async () => {
    const res = await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 4,
      method: "session.create",
      params: { title: "我的会话", username: "alice" },
    });
    expect(res).toMatchObject({ result: { id: "new-id" } });
    // username 作为 owner 透传给 createSession(title, owner)
    expect(chatStore.createSession).toHaveBeenCalledWith("我的会话", "alice");
  });

  it("session.create 缺 username 返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 4,
      method: "session.create",
      params: { title: "我的会话" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("session.list 带 username 返回该用户的会话数组", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 5,
      method: "session.list",
      params: { username: "alice" },
    })) as { result?: unknown[] };
    expect(Array.isArray(res.result)).toBe(true);
    expect(res.result).toHaveLength(1);
    // username 透传给 listSessions(owner)
    expect(chatStore.listSessions).toHaveBeenCalledWith("alice");
  });

  it("session.list 缺 username 返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 5,
      method: "session.list",
      params: {},
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("session.messages 缺 sessionId 返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 6,
      method: "session.messages",
      params: {},
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("session.delete 成功返回 ok", async () => {
    const res = await handleRpc(graphHolder, {
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
    const res = (await handleRpc(graphHolder, {
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
    const res = await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 10,
      method: "chat.interrupt",
      params: { sessionId: "s1" },
    });
    expect(res).toMatchObject({ result: { ok: true } });
    expect(controller.signal.aborted).toBe(true);
  });

  it("chat.interrupt 无进行中讨论也返回 ok(幂等)", async () => {
    const res = await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 11,
      method: "chat.interrupt",
      params: { sessionId: "s1" },
    });
    expect(res).toMatchObject({ result: { ok: true } });
  });

  it("chat.interrupt 缺 sessionId 返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 12,
      method: "chat.interrupt",
      params: {},
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("session.rename 成功返回 ok 并 trim 标题", async () => {
    const res = await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 13,
      method: "session.rename",
      params: { sessionId: "s1", title: "  新名字  " },
    });
    expect(res).toMatchObject({ result: { ok: true } });
    expect(chatStore.renameSession).toHaveBeenCalledWith("s1", "新名字");
  });

  it("session.rename 空标题返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 14,
      method: "session.rename",
      params: { sessionId: "s1", title: "   " },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("chat.end 缺 sessionId 返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 20,
      method: "chat.end",
      params: {},
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("chat.end busy 会话返回 -32000", async () => {
    sessions.setBusy("s1", true);
    const res = (await handleRpc(graphHolder, {
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
    const res = await handleRpc(graphHolder, {
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
    const res = (await handleRpc(graphHolder, {
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
    const res = await handleRpc(graphHolder, {
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
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 25,
      method: "chat.send",
      params: { sessionId: "s1", requirement: "继续讨论" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32000);
  });

  it("model.get 返回当前模型配置(含脱敏字段)", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 30,
      method: "model.get",
    })) as { result?: { baseUrl: string; modelName: string; apiKeyMasked: string; apiKeySet: boolean } };
    const r = res.result;
    expect(r).toBeDefined();
    expect(typeof r?.baseUrl).toBe("string");
    expect(typeof r?.modelName).toBe("string");
    expect(typeof r?.apiKeyMasked).toBe("string");
    expect(typeof r?.apiKeySet).toBe("boolean");
  });

  it("model.set 无任何字段返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 31,
      method: "model.set",
      params: { apiKey: "", baseUrl: "", modelName: "" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("model.set 非字符串字段返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 32,
      method: "model.set",
      params: { modelName: 123 },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("model.set 成功:重建图、换 holder.current、回新配置", async () => {
    vi.mocked(builder.buildGraph).mockClear();
    const before = graphHolder.current;
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 33,
      method: "model.set",
      params: { baseUrl: "https://new.example", modelName: "new-model" },
    })) as { result?: { apiKeySet: boolean } };
    expect(builder.buildGraph).toHaveBeenCalledTimes(1);
    expect(graphHolder.current).not.toBe(before); // holder 已换成重建的新图
    expect(typeof res.result?.apiKeySet).toBe("boolean");
    graphHolder.current = fakeGraph; // 还原,避免影响后续用例
  });

  it("chat.summaryTitle 成功:生成标题、写库、返回 title", async () => {
    vi.mocked(titleSummary.summarizeTitle).mockResolvedValue("登录页设计");
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 40,
      method: "chat.summaryTitle",
      params: { sessionId: "s1", requirement: "帮我做个登录页" },
    })) as { result?: { ok: boolean; title?: string } };
    expect(res.result).toMatchObject({ ok: true, title: "登录页设计" });
    expect(titleSummary.summarizeTitle).toHaveBeenCalledWith("帮我做个登录页");
    expect(chatStore.renameSession).toHaveBeenCalledWith("s1", "登录页设计");
  });

  it("chat.summaryTitle 缺参数返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 41,
      method: "chat.summaryTitle",
      params: { sessionId: "s1" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("chat.summaryTitle 空标题返回 ok:false 且不写库", async () => {
    vi.mocked(titleSummary.summarizeTitle).mockResolvedValue("");
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 42,
      method: "chat.summaryTitle",
      params: { sessionId: "s1", requirement: "x" },
    })) as { result?: { ok: boolean } };
    expect(res.result).toMatchObject({ ok: false });
    expect(chatStore.renameSession).not.toHaveBeenCalled();
  });

  it("user.registry 缺参数返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 50,
      method: "user.registry",
      params: { username: "alice" },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("user.registry 用户名已存在:回 ok:false reason:exists", async () => {
    vi.spyOn(userStore, "createUser").mockResolvedValue({ ok: false, reason: "exists" });
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 51,
      method: "user.registry",
      params: { username: "admin", password: "admin" },
    })) as { result?: { ok: boolean; reason?: string } };
    expect(res.result).toMatchObject({ ok: false, reason: "exists" });
    expect(userStore.createUser).toHaveBeenCalledWith("admin", "admin");
  });

  it("user.registry 成功:写库并回 ok:true", async () => {
    vi.spyOn(userStore, "createUser").mockResolvedValue({ ok: true });
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 52,
      method: "user.registry",
      params: { username: "bob", password: "pw123" },
    })) as { result?: { ok: boolean } };
    expect(res.result).toMatchObject({ ok: true });
    expect(userStore.createUser).toHaveBeenCalledWith("bob", "pw123");
  });

  it("user.getMemory 带 username 返回 { memory }", async () => {
    vi.spyOn(userStore, "getMemory").mockResolvedValue("我喜欢简洁设计");
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 60,
      method: "user.getMemory",
      params: { username: "alice" },
    })) as { result?: { memory: string } };
    expect(res.result).toMatchObject({ memory: "我喜欢简洁设计" });
    expect(userStore.getMemory).toHaveBeenCalledWith("alice");
  });

  it("user.getMemory 缺 username 返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 61,
      method: "user.getMemory",
      params: {},
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("user.setMemory 写库并回 ok:true(空串合法)", async () => {
    vi.spyOn(userStore, "setMemory").mockResolvedValue(undefined);
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 62,
      method: "user.setMemory",
      params: { username: "alice", memory: "" },
    })) as { result?: { ok: boolean } };
    expect(res.result).toMatchObject({ ok: true });
    expect(userStore.setMemory).toHaveBeenCalledWith("alice", "");
  });

  it("user.setMemory memory 非字符串返回 -32602", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 63,
      method: "user.setMemory",
      params: { username: "alice", memory: 123 },
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it("未知方法返回 -32601", async () => {
    const res = (await handleRpc(graphHolder, {
      jsonrpc: "2.0",
      id: 9,
      method: "nope",
    })) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32601);
  });
});
