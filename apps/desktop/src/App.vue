<script setup lang="ts">
import { onMounted } from "vue";
import { useSessionsStore } from "./stores/sessions.js";
import { useChatStore } from "./stores/chat.js";
import SessionList from "./components/SessionList.vue";
import ChatWindow from "./components/ChatWindow.vue";

const sessions = useSessionsStore();
const chat = useChatStore();

// 启动:先从服务端拉会话列表;一个都没有再建一个,避免空屏
onMounted(async () => {
  await sessions.load();
  // 把后端持久化的「已结束」状态灌进 chat store,刷新/重启后已结束的会议仍锁定。
  chat.hydrateEnded(sessions.list);
  if (sessions.list.length === 0) {
    await sessions.newSession();
  }
});
</script>

<template>
  <div class="app">
    <SessionList />
    <ChatWindow v-if="sessions.activeId" :session-id="sessions.activeId" />
    <section v-else class="empty">点击「+ 新会话」开始</section>
  </div>
</template>

<style>
/* 浅/深主题调色板:由 ui store 切换 <html data-theme> 级联到全应用。强调色 indigo 两套通用。 */
:root {
  --bg-app: #ffffff; --bg-sidebar: #f3f4f6; --bg-chat: #ffffff; --bg-elevated: #f3f4f6;
  --text-main: #111827; --text-dim: #5b6472; --text-sidebar: #1f2937;
  --border: #e5e7eb; --accent: #4f46e5;
  /* 侧栏里的"卡片"色:要明显亮于侧栏底色,会话项/新建按钮才不会糊进背景 */
  --bg-card: #ffffff; --bg-card-hover: #ffffff;
  --shadow-card: 0 1px 2px rgba(17, 24, 39, 0.06);
  --shadow-lift: 0 4px 12px rgba(17, 24, 39, 0.12);
  --accent-soft: rgba(79, 70, 229, 0.12);
}
:root[data-theme="dark"] {
  --bg-app: #1a1a1b; --bg-sidebar: #111827; --bg-chat: #1e1e20; --bg-elevated: #2a2a2d;
  --text-main: #f3f4f6; --text-dim: #9ca3af; --text-sidebar: #e5e7eb;
  --border: #374151; --accent: #6366f1;
  /* 深色下卡片要比侧栏底色(#111827)亮一档 */
  --bg-card: #1f2a3d; --bg-card-hover: #28344a;
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-lift: 0 4px 14px rgba(0, 0, 0, 0.5);
  --accent-soft: rgba(99, 102, 241, 0.22);
}
* { box-sizing: border-box; }
html, body, #app { margin: 0; height: 100%; }
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: var(--bg-app); color: var(--text-main); }
.app { display: flex; height: 100vh; }
.empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
</style>
