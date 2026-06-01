<script setup lang="ts">
import { onMounted } from "vue";
import { useSessionsStore } from "./stores/sessions.js";
import SessionList from "./components/SessionList.vue";
import ChatWindow from "./components/ChatWindow.vue";

const sessions = useSessionsStore();

// 启动:先从服务端拉会话列表;一个都没有再建一个,避免空屏
onMounted(async () => {
  await sessions.load();
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
* { box-sizing: border-box; }
html, body, #app { margin: 0; height: 100%; }
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
.app { display: flex; height: 100vh; }
.empty { flex: 1; display: flex; align-items: center; justify-content: center; color: #9ca3af; }
</style>
