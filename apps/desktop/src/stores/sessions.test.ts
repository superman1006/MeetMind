import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// 会话 store 通过 rpcClient 跟后端说话;打桩它,只验证 store 的状态流转与调用参数。
const rpcMock = vi.hoisted(() => vi.fn());
vi.mock("../api/rpcClient.js", () => ({ rpc: rpcMock }));

import { useSessionsStore } from "./sessions.js";

beforeEach(() => {
  setActivePinia(createPinia());
  rpcMock.mockReset();
});

describe("sessions store", () => {
  it("load 拉列表;无选中时默认选第一个", async () => {
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

  it("newSession 新建后插到最前并选中,返回新 id", async () => {
    rpcMock.mockResolvedValueOnce({ id: "new", title: "会话 1", ended: false });
    const s = useSessionsStore();
    const id = await s.newSession();
    expect(id).toBe("new");
    expect(s.list[0].id).toBe("new");
    expect(s.activeId).toBe("new");
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

  it("remove:删当前会话后切到剩余第一个", async () => {
    rpcMock.mockResolvedValue(undefined);
    const s = useSessionsStore();
    s.list = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
    s.activeId = "a";
    await s.remove("a");
    expect(rpcMock).toHaveBeenCalledWith("session.delete", { sessionId: "a" });
    expect(s.list).toHaveLength(1);
    expect(s.activeId).toBe("b");
  });

  it("remove:删光后 activeId 置空", async () => {
    rpcMock.mockResolvedValue(undefined);
    const s = useSessionsStore();
    s.list = [{ id: "a", title: "A" }];
    s.activeId = "a";
    await s.remove("a");
    expect(s.list).toHaveLength(0);
    expect(s.activeId).toBe("");
  });
});
