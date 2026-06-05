import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// auth store 通过 rpcClient 跟后端说话;打桩它,只验证 store 的状态流转与调用参数。
const rpcMock = vi.hoisted(() => vi.fn());
vi.mock("../api/rpcClient.js", () => ({ rpc: rpcMock }));

import { useAuthStore } from "./auth.js";

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

describe("auth store memory", () => {
  it("getMemory:调 user.getMemory 带当前 username,返回 memory 文本", async () => {
    rpcMock.mockResolvedValueOnce({ memory: "我喜欢简洁设计" });
    const auth = useAuthStore();
    auth.username = "alice";
    const memory = await auth.getMemory();
    expect(memory).toBe("我喜欢简洁设计");
    expect(rpcMock).toHaveBeenCalledWith("user.getMemory", { username: "alice" });
  });

  it("setMemory:调 user.setMemory 带当前 username 与新文本(空串合法)", async () => {
    rpcMock.mockResolvedValueOnce({ ok: true });
    const auth = useAuthStore();
    auth.username = "alice";
    await auth.setMemory("");
    expect(rpcMock).toHaveBeenCalledWith("user.setMemory", { username: "alice", memory: "" });
  });
});
