import { defineStore } from "pinia";

// 顶部轻提示的自动消失计时器 + 自增序号(模块级,不进 store state,避免被序列化)。
// 序号每次 showToast 自增,作为 Toast 组件的 :key,让连续触发也能重新播放进场动画。
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

// 会话列表宽度的上下限(px):太窄会话名糊成一团,太宽挤占对话区。拖拽时按此夹紧。
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_WIDTH_KEY = "meetmind-sidebar-width";

// 把任意值夹到 [min, max] 区间;NaN 时退回默认 220。
function clampSidebarWidth(px: number): number {
  if (Number.isNaN(px)) {
    return 220;
  }
  if (px < SIDEBAR_MIN_WIDTH) {
    return SIDEBAR_MIN_WIDTH;
  }
  if (px > SIDEBAR_MAX_WIDTH) {
    return SIDEBAR_MAX_WIDTH;
  }
  return px;
}

// 界面状态:会话列表是否收缩 + 浅/深主题 + 顶部轻提示。独立成 store,避免组件间传 prop。
export const useUiStore = defineStore("ui", {
  state: () => ({
    sidebarCollapsed: false,
    // 会话列表展开态的宽度(px),由中间分隔条拖拽调节;持久化到 localStorage。
    sidebarWidth: 220,
    // 拖拽进行中标志:为真时关掉 .sidebar 的 width 过渡,让宽度跟手不延迟(不持久化)。
    sidebarResizing: false,
    theme: "light" as "light" | "dark",
    // 右上角一闪即逝的轻提示(如「会话已删除」);null 表示当前无提示。
    toast: null as { id: number; message: string } | null,
  }),
  actions: {
    toggleSidebar(): void {
      this.sidebarCollapsed = !this.sidebarCollapsed;
    },
    // 启动时调用(main.ts,mount 前):从 localStorage 恢复列表宽度,夹紧后写回 state,避免首帧跳动。
    initSidebarWidth(): void {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      } catch {
        // 隐私模式等 localStorage 不可用:当作没存过,用默认 220
        saved = null;
      }
      if (saved === null) {
        return;
      }
      const parsed = Number.parseInt(saved, 10);
      this.sidebarWidth = clampSidebarWidth(parsed);
    },
    // 拖拽中持续调用:夹紧到上下限后更新宽度并持久化。
    setSidebarWidth(px: number): void {
      const next = clampSidebarWidth(px);
      this.sidebarWidth = next;
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
      } catch {
        // 不可用就只改不存,不抛错
      }
    },
    // 把当前主题写到 <html data-theme>,App.vue 里的 CSS 变量据此级联到全应用。
    applyTheme(): void {
      document.documentElement.setAttribute("data-theme", this.theme);
    },
    // 启动时调用(main.ts,mount 前):从 localStorage 恢复主题(默认 light),并应用,避免首帧闪烁。
    initTheme(): void {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem("meetmind-theme");
      } catch {
        // 隐私模式等 localStorage 不可用:当作没存过,用默认
        saved = null;
      }
      this.theme = saved === "dark" ? "dark" : "light";
      this.applyTheme();
    },
    // 圆按钮点击:翻转主题 + 持久化 + 应用。
    toggleTheme(): void {
      this.theme = this.theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("meetmind-theme", this.theme);
      } catch {
        // 不可用就只切不存,不抛错
      }
      this.applyTheme();
    },
    // 弹一条右上角轻提示,默认 3 秒后自动消失;期间再次触发会重置计时并重播动画。
    showToast(message: string): void {
      toastSeq += 1;
      this.toast = { id: toastSeq, message };
      if (toastTimer) {
        clearTimeout(toastTimer);
      }
      toastTimer = setTimeout(() => {
        this.toast = null;
        toastTimer = null;
      }, 3000);
    },
    // 手动关闭(点 × 时调),顺手清掉自动消失计时器。
    dismissToast(): void {
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      this.toast = null;
    },
  },
});
