import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { useUiStore } from "./stores/ui.js";

const app = createApp(App);
app.use(createPinia());
// mount 前先恢复并应用主题,避免首帧用默认浅色再跳深色的闪烁。
useUiStore().initTheme();
app.mount("#app");
