import { describe, it, expect } from "vitest";
import { createPending, resolve } from "./toolApprovals.js";

describe("toolApprovals(工具审批挂起注册表)", () => {
  it("resolve(true) 让挂起 Promise 兑现为 true", async () => {
    const p = createPending("a1");
    expect(resolve("a1", true)).toBe(true);
    await expect(p).resolves.toBe(true);
  });

  it("resolve(false) 让挂起 Promise 兑现为 false", async () => {
    const p = createPending("a2");
    resolve("a2", false);
    await expect(p).resolves.toBe(false);
  });

  it("未知 approvalId 的 resolve 幂等返回 false、不抛错", () => {
    expect(resolve("nope", true)).toBe(false);
  });

  it("同一 approvalId 只能兑现一次", async () => {
    const p = createPending("a3");
    expect(resolve("a3", true)).toBe(true);
    // 第二次找不到了,返回 false
    expect(resolve("a3", false)).toBe(false);
    await expect(p).resolves.toBe(true);
  });

  it("signal 已 abort 时 createPending 直接 reject", async () => {
    const controller = new AbortController();
    controller.abort();
    const p = createPending("a4", controller.signal);
    await expect(p).rejects.toThrow();
  });

  it("挂起期间 abort 会取消审批(reject)并使后续 resolve 幂等返回 false", async () => {
    const controller = new AbortController();
    const p = createPending("a5", controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow();
    // 已被取消,前端迟到的决策幂等返回 false
    expect(resolve("a5", true)).toBe(false);
  });
});
