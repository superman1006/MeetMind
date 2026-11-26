import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { useUiStore } from "./stores/ui.js";
import { useAuthStore } from "./stores/auth.js";
import "./theme/popupMotion.css";

const app = createApp(App);
app.use(createPinia());
// mount 前先恢复并应用主题,避免首帧用默认浅色再跳深色的闪烁。
const ui = useUiStore();
ui.initTheme();
// 同样在 mount 前恢复会话列表宽度,避免首帧用默认 220 再跳到自定义宽度。
ui.initSidebarWidth();
// 从后端确认登录凭据，再显示账号对应的会话。
const auth = useAuthStore();
window.addEventListener("meetmind-auth-expired", () => auth.clearLogin());
void auth.initAuth().then(() => app.mount("#app"));
