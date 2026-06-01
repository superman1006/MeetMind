<script setup lang="ts">
import { useSessionsStore } from "../stores/sessions.js";

const sessions = useSessionsStore();
</script>

<template>
  <aside class="sidebar">
    <button class="new" @click="sessions.newSession()">+ 新会话</button>
    <ul class="list">
      <li
        v-for="s in sessions.list"
        :key="s.id"
        :class="{ active: s.id === sessions.activeId }"
        @click="sessions.select(s.id)"
      >
        {{ s.title }}
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.sidebar { width: 220px; background: #1f2937; color: #e5e7eb; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; }
.new { background: #374151; color: #e5e7eb; border: none; border-radius: 8px; padding: 8px; cursor: pointer; margin-bottom: 12px; }
.new:hover { background: #4b5563; }
.list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
.list li { padding: 8px; border-radius: 8px; cursor: pointer; font-size: 14px; }
.list li.active, .list li:hover { background: #374151; }
</style>
