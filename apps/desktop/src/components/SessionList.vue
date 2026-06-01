<script setup lang="ts">
import { ref, nextTick } from "vue";
import type { ComponentPublicInstance } from "vue";
import { useSessionsStore } from "../stores/sessions.js";
import { useUiStore } from "../stores/ui.js";
import { useChatStore } from "../stores/chat.js";
import ConfirmDialog from "./ConfirmDialog.vue";

const sessions = useSessionsStore();
const ui = useUiStore();
const chat = useChatStore();

// ---------- 重命名(行内编辑) ----------
const editingId = ref<string>("");
const editingText = ref<string>("");
const editInput = ref<HTMLInputElement | null>(null);

// 函数式 ref:v-for 内的字符串 ref 会变成数组,这里用函数 ref 保证只持有当前渲染的那个输入框。
function setEditInput(el: Element | ComponentPublicInstance | null): void {
  editInput.value = (el as HTMLInputElement | null) ?? null;
}

async function startRename(id: string, title: string): Promise<void> {
  editingId.value = id;
  editingText.value = title;
  await nextTick();
  editInput.value?.focus();
  editInput.value?.select();
}

function cancelRename(): void {
  editingId.value = "";
}

async function commitRename(): Promise<void> {
  const id = editingId.value;
  if (!id) {
    return; // 已被取消(Esc)则不提交
  }
  const text = editingText.value.trim();
  editingId.value = "";
  if (!text) {
    return; // 空名当取消,保留原标题
  }
  try {
    await sessions.rename(id, text);
  } catch (e) {
    console.error("[SessionList] 重命名失败:", e);
  }
}

function onRenameKeydown(e: KeyboardEvent): void {
  // 输入法合成中按回车是上屏候选词,不提交
  if (e.isComposing || e.keyCode === 229) {
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    commitRename();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelRename();
  }
}

// ---------- 删除(自定义确认弹窗) ----------
const pendingDelete = ref<{ id: string; title: string } | null>(null);

function askDelete(id: string, title: string): void {
  pendingDelete.value = { id, title };
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  pendingDelete.value = null;
  if (!target) {
    return;
  }
  try {
    await sessions.remove(target.id);
    chat.drop(target.id);
  } catch (e) {
    console.error("[SessionList] 删除失败:", e);
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
        <!-- 编辑态:行内输入框;否则显示标题 + 悬停按钮 -->
        <input
          v-if="editingId === s.id"
          :ref="setEditInput"
          v-model="editingText"
          class="rename-input"
          @click.stop
          @keydown="onRenameKeydown"
          @blur="commitRename"
        />
        <template v-else>
          <span class="name">{{ s.title }}</span>
          <button class="icon" title="重命名会话" @click.stop="startRename(s.id, s.title)">✎</button>
          <button class="icon" title="删除会话" @click.stop="askDelete(s.id, s.title)">×</button>
        </template>
      </li>
    </ul>
  </aside>

  <!-- 自定义删除确认弹窗(替代 window.confirm) -->
  <ConfirmDialog
    v-if="pendingDelete"
    title="删除会话?"
    :message="`「${pendingDelete.title}」将被永久删除，此操作不可撤销。`"
    confirm-label="删除"
    cancel-label="取消"
    danger
    @confirm="confirmDelete"
    @cancel="pendingDelete = null"
  />
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
/* 重命名 / 删除 共用的悬停小按钮 */
.icon { visibility: hidden; background: transparent; color: #9ca3af; border: none; border-radius: 6px; width: 22px; height: 22px; line-height: 1; font-size: 15px; cursor: pointer; flex-shrink: 0; }
.list li:hover .icon { visibility: visible; }
.icon:hover { background: #6b7280; color: #fff; }
/* 行内重命名输入框 */
.rename-input { flex: 1; min-width: 0; background: #111827; color: #f9fafb; border: 1px solid #4f46e5; border-radius: 6px; padding: 5px 7px; font-size: 14px; font-family: inherit; outline: none; }
</style>
