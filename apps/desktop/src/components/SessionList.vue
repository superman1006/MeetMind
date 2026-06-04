<script setup lang="ts">
import { ref, nextTick } from "vue";
import type { ComponentPublicInstance } from "vue";
import { useSessionsStore } from "../stores/sessions.js";
import { useUiStore } from "../stores/ui.js";
import { useChatStore } from "../stores/chat.js";
import ConfirmDialog from "./ConfirmDialog.vue";
import Tooltip from "./Tooltip.vue";
import SessionSearch from "./SessionSearch.vue";

const sessions = useSessionsStore();
const ui = useUiStore();
const chat = useChatStore();

// ---------- 搜索 ----------
const searchOpen = ref(false);
function onPick(id: string): void {
  sessions.select(id);
  searchOpen.value = false;
}

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
    ui.showToast("会话已删除");
  } catch (e) {
    console.error("[SessionList] 删除失败:", e);
  }
}
</script>

<template>
  <!-- 收缩态:窄轨,只留一个展开按钮 -->
  <aside v-if="ui.sidebarCollapsed" class="rail">
    <Tooltip label="展开会话列表" placement="right">
      <button class="toggle" aria-label="展开会话列表" @click="ui.toggleSidebar()">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="9" y1="4" x2="9" y2="20" />
        </svg>
      </button>
    </Tooltip>
    <button
      class="theme-toggle"
      :title="ui.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'"
      @click="ui.toggleTheme()"
    >
      {{ ui.theme === "dark" ? "☀️" : "🌙" }}
    </button>
  </aside>

  <!-- 展开态:header(右上角收缩按钮) + 新会话 + 列表 -->
  <aside v-else class="sidebar">
    <div class="header">
      <span class="title">会话</span>
      <div class="header-actions">
        <Tooltip label="搜索">
          <button class="toggle" aria-label="搜索会话" @click="searchOpen = true">
            <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip label="收缩会话列表">
          <button class="toggle" aria-label="收缩会话列表" @click="ui.toggleSidebar()">
            <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="9" y1="4" x2="9" y2="20" />
            </svg>
          </button>
        </Tooltip>
      </div>
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
    <button
      class="theme-toggle"
      :title="ui.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'"
      @click="ui.toggleTheme()"
    >
      {{ ui.theme === "dark" ? "☀️" : "🌙" }}
    </button>
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

  <!-- 会话标题搜索模态 -->
  <SessionSearch
    v-if="searchOpen"
    :sessions="sessions.list"
    @select="onPick"
    @close="searchOpen = false"
  />
</template>

<style scoped>
.sidebar { width: 220px; background: var(--bg-sidebar); color: var(--text-sidebar); display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; transition: width 0.18s ease; }
.rail { width: 40px; background: var(--bg-sidebar); color: var(--text-sidebar); display: flex; flex-direction: column; align-items: center; padding: 12px 0; box-sizing: border-box; transition: width 0.18s ease; }
.header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.title { font-size: 14px; font-weight: 600; }
.header-actions { display: flex; align-items: center; gap: 6px; }
.toggle { display: inline-flex; align-items: center; justify-content: center; background: var(--bg-elevated); color: var(--text-sidebar); border: none; border-radius: 8px; width: 28px; height: 28px; line-height: 1; cursor: pointer; font-size: 16px; }
.toggle:hover { filter: brightness(1.12); }
.toggle .ic { width: 18px; height: 18px; }
/* 新建会话:实心强调色按钮,悬浮微微上浮 + 阴影加深 */
.new { background: var(--accent); color: #fff; border: none; border-radius: 10px; padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer; margin-bottom: 14px; box-shadow: var(--shadow-card); transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease; }
.new:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); filter: brightness(1.05); }
.new:active { transform: translateY(0); box-shadow: var(--shadow-card); }
.list { list-style: none; margin: 0; padding: 2px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 8px; }
/* 会话项做成卡片:亮于侧栏底色 + 细边 + 浅阴影,与背景拉开层次 */
.list li { display: flex; align-items: center; gap: 6px; padding: 10px; border-radius: 10px; cursor: pointer; font-size: 14px; background: var(--bg-card); border: 1px solid var(--border); box-shadow: var(--shadow-card); transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease, border-color 0.15s ease; }
.list li:hover { background: var(--bg-card-hover); transform: translateY(-2px); box-shadow: var(--shadow-lift); }
/* 选中态:强调色边框 + 淡强调底色,一眼可辨 */
.list li.active { background: var(--accent-soft); border-color: var(--accent); }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 重命名 / 删除 共用的悬停小按钮 */
.icon { visibility: hidden; background: transparent; color: var(--text-dim); border: none; border-radius: 6px; width: 22px; height: 22px; line-height: 1; font-size: 15px; cursor: pointer; flex-shrink: 0; }
.list li:hover .icon { visibility: visible; }
.icon:hover { background: var(--bg-sidebar); color: var(--text-main); }
/* 行内重命名输入框 */
.rename-input { flex: 1; min-width: 0; background: var(--bg-app); color: var(--text-main); border: 1px solid var(--accent); border-radius: 6px; padding: 5px 7px; font-size: 14px; font-family: inherit; outline: none; }
/* 浅/深主题切换圆按钮:展开态钉右下角,收缩 rail 态钉底部居中 */
.theme-toggle { align-self: flex-end; margin-top: 8px; width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer; font-size: 18px; line-height: 1; background: var(--bg-elevated); color: var(--text-sidebar); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.theme-toggle:hover { filter: brightness(1.12); }
.rail .theme-toggle { align-self: center; margin-top: auto; }
</style>
