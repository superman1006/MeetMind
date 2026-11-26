import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// 会话 store 通过 rpcClient 跟后端说话;打桩它,只验证 store 的状态流转与调用参数。
const rpcMock = vi.hoisted(() => vi.fn());
vi.mock("../../api/rpcClient.js", () => ({ rpc: rpcMock }));

import { useSessionsStore } from "../sessions.js";

beforeEach(() => {
  setActivePinia(createPinia());
  rpcMock.mockReset();
});

describe("sessions store", () => {
  it("load 拉取当前登录账号的列表并优先选择未归档会议", async () => {
    rpcMock.mockResolvedValueOnce([
      { id: "a", title: "A", ended: false },
      { id: "b", title: "B", ended: false },
    ]);
    const s = useSessionsStore();
    await s.load();
    expect(s.list).toHaveLength(2);
    expect(s.activeId).toBe("a");
    expect(rpcMock).toHaveBeenCalledWith("session.list", {});
  });

  it("newSession 提交参会名单并选中新建会议", async () => {
    rpcMock.mockResolvedValueOnce({ id: "new", title: "会话 1", ended: false });
    const s = useSessionsStore();
    const id = await s.newSession(["architect", "alice"], "会话 1");
    expect(id).toBe("new");
    expect(s.list[0].id).toBe("new");
    expect(s.activeId).toBe("new");
    expect(rpcMock).toHaveBeenCalledWith("session.create", { title: "会话 1", participants: ["architect", "alice"] });
  });

  it("select 切换 activeId", () => {
    const s = useSessionsStore();
    s.select("x");
    expect(s.activeId).toBe("x");
  });

  it("rename:trim 后调 rpc 并更新本地标题", async () => {
    rpcMock.mockResolvedValue(undefined);
    const s = useSessionsStore();
    s.list = [{ id: "a", title: "旧" }];
    await s.rename("a", "  新名  ");
    expect(rpcMock).toHaveBeenCalledWith("session.rename", { sessionId: "a", title: "新名" });
    expect(s.list[0].title).toBe("新名");
  });

  it("rename:空标题直接返回,不调 rpc", async () => {
    const s = useSessionsStore();
    await s.rename("a", "   ");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("setTitle:只更新本地标题,不调 rpc", () => {
    const s = useSessionsStore();
    s.list = [{ id: "a", title: "旧" }, { id: "b", title: "B" }];
    s.setTitle("a", "自动标题");
    expect(s.list[0].title).toBe("自动标题");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("setTitle:未知 id 不报错、不改动其它项", () => {
    const s = useSessionsStore();
    s.list = [{ id: "a", title: "旧" }];
    s.setTitle("zzz", "x");
    expect(s.list[0].title).toBe("旧");
  });

  it("归档后保留会议和当前选中状态", async () => {
    rpcMock.mockResolvedValue(undefined);
    const s = useSessionsStore();
    s.list = [{ id: "a", title: "A" }];
    s.activeId = "a";
    await s.archive("a", true);
    expect(rpcMock).toHaveBeenCalledWith("session.archive", { sessionId: "a", archived: true });
    expect(s.list).toEqual([{ id: "a", title: "A", archived: true }]);
    expect(s.activeId).toBe("a");
  });
});
