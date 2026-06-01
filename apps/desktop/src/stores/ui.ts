import { defineStore } from "pinia";

// 界面状态:目前只有会话列表是否收缩。独立成 store,避免 App↔SessionList 传 prop。
export const useUiStore = defineStore("ui", {
  state: () => ({
    sidebarCollapsed: false,
  }),
  actions: {
    toggleSidebar(): void {
      this.sidebarCollapsed = !this.sidebarCollapsed;
    },
  },
});
