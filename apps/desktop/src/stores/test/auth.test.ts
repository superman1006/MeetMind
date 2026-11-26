import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// auth store 通过 rpcClient 跟后端说话;打桩它,只验证 store 的状态流转与调用参数。
const rpcMock = vi.hoisted(() => vi.fn());
vi.mock("../../api/rpcClient.js", () => ({ rpc: rpcMock }));

import { useAuthStore } from "../auth.js";

beforeEach(() => {
  setActivePinia(createPinia());
  rpcMock.mockReset();
});

describe("auth store register", () => {
  it("注册成功:调 user.registry、回 ok:true,且不自动登录", async () => {
    rpcMock.mockResolvedValueOnce({ ok: true });
    const auth = useAuthStore();
    const result = await auth.register("alice", "pw123");
    expect(result).toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith("user.registry", { username: "alice", password: "pw123" });
    // 注册不登录:用户名仍为空,App.vue 据此留在登录页。
    expect(auth.username).toBe("");
    expect(auth.loggedIn).toBe(false);
  });

  it("用户名已存在:回 ok:false reason:exists,不改登录态", async () => {
    rpcMock.mockResolvedValueOnce({ ok: false, reason: "exists" });
    const auth = useAuthStore();
    const result = await auth.register("admin", "admin");
    expect(result).toEqual({ ok: false, reason: "exists" });
    expect(auth.username).toBe("");
  });
});

describe("auth store session", () => {
  it("从服务器恢复登录账号", async () => {
    rpcMock.mockResolvedValueOnce({ username: "alice" });
    const auth = useAuthStore();
    await auth.initAuth();
    expect(auth.loggedIn).toBe(true);
    expect(auth.username).toBe("alice");
    expect(rpcMock).toHaveBeenCalledWith("user.me", {});
  });

  it("先从服务器撤销登录凭据，再退出界面", async () => {
    rpcMock.mockResolvedValueOnce({ ok: true });
    const auth = useAuthStore();
    auth.username = "alice";
    await auth.logout();
    expect(rpcMock).toHaveBeenCalledWith("user.logout", {});
    expect(auth.username).toBe("");
  });
});
