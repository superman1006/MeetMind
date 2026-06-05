import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { useUiStore } from "./stores/ui.js";
import { useAuthStore } from "./stores/auth.js";

const app = createApp(App);
app.use(createPinia());
// mount 前先恢复并应用主题,避免首帧用默认浅色再跳深色的闪烁。
const ui = useUiStore();
ui.initTheme();
// 同样在 mount 前恢复会话列表宽度,避免首帧用默认 220 再跳到自定义宽度。
ui.initSidebarWidth();
// mount 前先恢复登录态:已登录(localStorage 有用户名)直接进会话界面,否则显示登录页。
useAuthStore().initAuth();
app.mount("#app");
