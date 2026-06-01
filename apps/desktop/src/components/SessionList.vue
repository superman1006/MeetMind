<script setup lang="ts">
import { useSessionsStore } from "../stores/sessions.js";
import { useUiStore } from "../stores/ui.js";
import { useChatStore } from "../stores/chat.js";

const sessions = useSessionsStore();
const ui = useUiStore();
const chat = useChatStore();

// 删除会话:二次确认 → 服务端级联删 PG → 移除本地气泡。
async function onDelete(id: string, title: string): Promise<void> {
  const ok = window.confirm(`确定删除「${title}」?\n该会话的所有消息将从数据库中永久删除。`);
  if (!ok) {
    return;
  }
  try {
    await sessions.remove(id);
    chat.drop(id);
  } catch (e) {
    window.alert(`删除失败: ${String(e)}`);
  }
}
</script>

<template>
  <!-- 收缩态:窄轨,只留一个展开按钮 -->
  <aside v-if="ui.sidebarCollapsed" class="rail">
    <button class="toggle" title="展开会话列表" @click="ui.toggleSidebar()">»</button>
  </aside>

  <!-- 展开态:header(右上角收缩按钮) + 新会话 + 列表 -->
  <aside v-else class="sidebar">
    <div class="header">
      <span class="title">会话</span>
      <button class="toggle" title="收缩会话列表" @click="ui.toggleSidebar()">«</button>
    </div>
    <button class="new" @click="sessions.newSession()">+ 新会话</button>
    <ul class="list">
      <li
        v-for="s in sessions.list"
        :key="s.id"
        :class="{ active: s.id === sessions.activeId }"
        @click="sessions.select(s.id)"
      >
        <span class="name">{{ s.title }}</span>
        <button class="del" title="删除会话" @click.stop="onDelete(s.id, s.title)">×</button>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.sidebar { width: 220px; background: #1f2937; color: #e5e7eb; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; transition: width 0.18s ease; }
.rail { width: 40px; background: #1f2937; color: #e5e7eb; display: flex; flex-direction: column; align-items: center; padding: 12px 0; box-sizing: border-box; transition: width 0.18s ease; }
.header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.title { font-size: 14px; font-weight: 600; }
.toggle { background: #374151; color: #e5e7eb; border: none; border-radius: 8px; width: 28px; height: 28px; line-height: 1; cursor: pointer; font-size: 16px; }
.toggle:hover { background: #4b5563; }
.new { background: #374151; color: #e5e7eb; border: none; border-radius: 8px; padding: 8px; cursor: pointer; margin-bottom: 12px; }
.new:hover { background: #4b5563; }
.list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
.list li { display: flex; align-items: center; gap: 6px; padding: 8px; border-radius: 8px; cursor: pointer; font-size: 14px; }
.list li.active, .list li:hover { background: #374151; }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.del { visibility: hidden; background: transparent; color: #9ca3af; border: none; border-radius: 6px; width: 22px; height: 22px; line-height: 1; font-size: 16px; cursor: pointer; flex-shrink: 0; }
.list li:hover .del { visibility: visible; }
.del:hover { background: #6b7280; color: #fff; }
</style>
