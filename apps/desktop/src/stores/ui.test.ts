import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

import { useUiStore } from "./ui.js";

// Node 25 自带一个全局 localStorage,会盖过 happy-dom 的实现且行为不一致;
// 这里直接用内存版打桩,既稳定又能断言读写。document 仍用 happy-dom 的真实现。
function makeStorageStub() {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => {
      store[k] = String(v);
    },
    removeItem: (k: string): void => {
      delete store[k];
    },
    clear: (): void => {
      store = {};
    },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("localStorage", makeStorageStub());
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ui store", () => {
  it("toggleSidebar 翻转收缩状态", () => {
    const ui = useUiStore();
    expect(ui.sidebarCollapsed).toBe(false);
    ui.toggleSidebar();
    expect(ui.sidebarCollapsed).toBe(true);
    ui.toggleSidebar();
    expect(ui.sidebarCollapsed).toBe(false);
  });

  it("toggleTheme 翻转主题 + 持久化 + 写 <html data-theme>", () => {
    const ui = useUiStore();
    expect(ui.theme).toBe("light");
    ui.toggleTheme();
    expect(ui.theme).toBe("dark");
    expect(localStorage.getItem("meetmind-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    ui.toggleTheme();
    expect(ui.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("initTheme:localStorage 存了 dark → 恢复 dark", () => {
    localStorage.setItem("meetmind-theme", "dark");
    const ui = useUiStore();
    ui.initTheme();
    expect(ui.theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("initTheme:没存过 → 默认 light", () => {
    const ui = useUiStore();
    ui.initTheme();
    expect(ui.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("showToast 弹提示,3 秒后自动消失", () => {
    vi.useFakeTimers();
    const ui = useUiStore();
    expect(ui.toast).toBeNull();
    ui.showToast("会话已删除");
    expect(ui.toast?.message).toBe("会话已删除");
    vi.advanceTimersByTime(3000);
    expect(ui.toast).toBeNull();
    vi.useRealTimers();
  });

  it("连续 showToast 会换 id 并重置自动消失计时", () => {
    vi.useFakeTimers();
    const ui = useUiStore();
    ui.showToast("第一条");
    const firstId = ui.toast?.id;
    vi.advanceTimersByTime(2000);
    ui.showToast("第二条");
    expect(ui.toast?.message).toBe("第二条");
    expect(ui.toast?.id).not.toBe(firstId);
    // 距第二条只过了 2 秒,仍在
    vi.advanceTimersByTime(2000);
    expect(ui.toast?.message).toBe("第二条");
    // 再过 1 秒满 3 秒,消失
    vi.advanceTimersByTime(1000);
    expect(ui.toast).toBeNull();
    vi.useRealTimers();
  });

  it("dismissToast 立即关闭并取消计时", () => {
    vi.useFakeTimers();
    const ui = useUiStore();
    ui.showToast("会话已删除");
    ui.dismissToast();
    expect(ui.toast).toBeNull();
    // 计时已被取消,推进时间不会再有副作用
    vi.advanceTimersByTime(3000);
    expect(ui.toast).toBeNull();
    vi.useRealTimers();
  });
});
