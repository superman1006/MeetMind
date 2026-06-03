import { defineStore } from "pinia";

// 界面状态:会话列表是否收缩 + 浅/深主题。独立成 store,避免组件间传 prop。
export const useUiStore = defineStore("ui", {
  state: () => ({
    sidebarCollapsed: false,
    theme: "light" as "light" | "dark",
  }),
  actions: {
    toggleSidebar(): void {
      this.sidebarCollapsed = !this.sidebarCollapsed;
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
  },
});
