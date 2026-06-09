<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from "vue";
import type { ComponentPublicInstance } from "vue";
import { useSessionsStore } from "../stores/sessions.js";
import { useUiStore } from "../stores/ui.js";
import { useChatStore } from "../stores/chat.js";
import { useAuthStore } from "../stores/auth.js";
import ConfirmDialog from "./ConfirmDialog.vue";
import Tooltip from "./Tooltip.vue";
import SessionSearch from "./SessionSearch.vue";
import ModelSettings from "./ModelSettings.vue";
import UserMemory from "./UserMemory.vue";
import { groupSessionsByTime } from "../utils/sessionGroups.js";

const sessions = useSessionsStore();
const ui = useUiStore();
const chat = useChatStore();
const auth = useAuthStore();

// 会话按 created_at 新旧分到 5 个时间段(今天 / 昨天 / 7 天内 / 30 天内 / 更早),空段不显示。
// 每次列表变化都重新分桶并取一次「现在」;段内顺序沿用服务端的 created_at DESC。
const sessionGroups = computed(() => groupSessionsByTime(sessions.list, Date.now()));

// 用户名头像首字:取用户名第一个字符大写,登出胶囊 / rail 头像用。
const avatarChar = computed(() => {
  const name = auth.username;
  if (!name) {
    return "?";
  }
  return name.charAt(0).toUpperCase();
});

// ---------- 模型配置面板 ----------
const settingsOpen = ref(false);

// ---------- 账户菜单(头像点开的小弹层)+ 用户记忆窗口 ----------
// 头像点击不再直接登出,而是弹出一个含「用户记忆」「退出登陆」两个按钮的 popover。
const menuOpen = ref(false);
const memoryOpen = ref(false);

function toggleAccountMenu(): void {
  menuOpen.value = !menuOpen.value;
}

function openMemory(): void {
  menuOpen.value = false;
  memoryOpen.value = true;
}

// Esc 关闭账户菜单(记忆窗口自己另有 Esc 处理)。
function onMenuKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && menuOpen.value) {
    menuOpen.value = false;
  }
}

onMounted(() => window.addEventListener("keydown", onMenuKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onMenuKeydown));

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
    <Tooltip label="模型配置" placement="right">
      <button class="toggle" aria-label="模型配置" @click="settingsOpen = true">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </Tooltip>
    <div class="rail-footer">
      <!-- 收缩态:圆形头像(用户名首字),点击弹出账户菜单 -->
      <div class="user-wrap">
        <Tooltip :label="`账户 ${auth.username}`" placement="right">
          <button class="rail-avatar" :aria-label="`账户 ${auth.username}`" @click.stop="toggleAccountMenu">
            {{ avatarChar }}
          </button>
        </Tooltip>
        <div v-if="menuOpen" class="user-menu rail-menu">
          <button class="menu-item" @click="openMemory">用户记忆</button>
          <button class="menu-item" @click="auth.logout()">退出登陆</button>
        </div>
      </div>
      <button
        class="theme-toggle"
        :title="ui.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'"
        @click="ui.toggleTheme()"
      >
        <!-- 深色态显示太阳(点了切到浅色),浅色态显示月亮(点了切到深色),线条风格与其余图标统一 -->
        <svg v-if="ui.theme === 'dark'" class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
        <svg v-else class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </button>
    </div>
  </aside>

  <!-- 展开态:header(右上角收缩按钮) + 新会话 + 列表 -->
  <aside v-else class="sidebar" :class="{ resizing: ui.sidebarResizing }" :style="{ width: ui.sidebarWidth + 'px' }">
    <div class="header">
      <span class="title">MeetMind</span>
      <div class="header-actions">
        <Tooltip label="模型配置">
          <button class="toggle" aria-label="模型配置" @click="settingsOpen = true">
            <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </Tooltip>
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
      <!-- 按时间段分组:每段一个不可点的小标题,后跟该段的会话卡片 -->
      <template v-for="g in sessionGroups" :key="g.label">
        <li class="group-head">{{ g.label }}</li>
        <li
          v-for="s in g.sessions"
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
      </template>
    </ul>
    <div class="footer">
      <!-- 左下角:圆角长方体用户名胶囊,点击弹出账户菜单 -->
      <div class="user-wrap">
        <Tooltip :label="`账户 ${auth.username}`" placement="top">
          <button class="user-chip" :aria-label="`账户 ${auth.username}`" @click.stop="toggleAccountMenu">
            <span class="avatar">{{ avatarChar }}</span>
            <span class="uname">{{ auth.username }}</span>
          </button>
        </Tooltip>
        <div v-if="menuOpen" class="user-menu">
          <button class="menu-item" @click="openMemory">用户记忆</button>
          <button class="menu-item" @click="auth.logout()">退出登陆</button>
        </div>
      </div>
      <button
        class="theme-toggle"
        :title="ui.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'"
        @click="ui.toggleTheme()"
      >
        <!-- 深色态显示太阳(点了切到浅色),浅色态显示月亮(点了切到深色),线条风格与其余图标统一 -->
        <svg v-if="ui.theme === 'dark'" class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
        <svg v-else class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </button>
    </div>
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

  <!-- LLM 模型配置面板 -->
  <ModelSettings v-if="settingsOpen" @close="settingsOpen = false" />

  <!-- 账户菜单的透明背板:点菜单外部任意处关闭(收缩/展开态共用) -->
  <div v-if="menuOpen" class="menu-backdrop" @click="menuOpen = false" />

  <!-- 用户记忆窗口 -->
  <UserMemory v-if="memoryOpen" @close="memoryOpen = false" />
</template>

<style scoped>
/* 宽度由内联 style(ui.sidebarWidth)给,这里的 220px 仅作兜底;flex-shrink:0 不让对话区把它压扁。 */
.sidebar { width: 220px; flex-shrink: 0; background: var(--bg-sidebar); color: var(--text-sidebar); display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; transition: width 0.18s ease; }
/* 拖拽中关掉 width 过渡,让侧栏宽度跟手不延迟。 */
.sidebar.resizing { transition: none; }
.rail { width: 40px; background: var(--bg-sidebar); color: var(--text-sidebar); display: flex; flex-direction: column; align-items: center; padding: 12px 0; box-sizing: border-box; transition: width 0.18s ease; }
.header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.title { font-size: 15px; font-weight: 600; }
.header-actions { display: flex; align-items: center; gap: 6px; }
.toggle { display: inline-flex; align-items: center; justify-content: center; background: var(--bg-elevated); color: var(--text-sidebar); border: none; border-radius: 8px; width: 28px; height: 28px; line-height: 1; cursor: pointer; font-size: 16px; }
.toggle:hover { filter: brightness(1.12); }
.toggle .ic { width: 18px; height: 18px; }
/* 新建会话:实心强调色按钮,悬浮微微上浮 + 阴影加深 */
.new { background: var(--accent); color: #fff; border: none; border-radius: 10px; padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer; margin-bottom: 14px; box-shadow: var(--shadow-card); transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease; }
.new:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); filter: brightness(1.05); }
.new:active { transform: translateY(0); box-shadow: var(--shadow-card); }
.list { list-style: none; margin: 0; padding: 2px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 8px; }
/* 时间段小标题:一行左靠边的灰色小字,不是卡片。
   ⚠️ 必须用 .list li.group-head(0,2,1)压过下面的 .list li(0,1,1),否则会被卡片的底色/边框/阴影覆盖。
   首个标题去掉上间距,避免顶部空一截。 */
.list li.group-head { display: block; font-size: 12px; font-weight: 600; color: var(--text-dim); text-transform: none; letter-spacing: 0.02em; padding: 8px 4px 2px; margin-top: 4px; border-radius: 0; background: transparent; border: none; box-shadow: none; cursor: default; user-select: none; }
.list li.group-head:first-child { margin-top: 0; }
/* 标题不是可点卡片,悬停不做上浮 / 高亮(覆盖 .list li:hover)。 */
.list li.group-head:hover { background: transparent; transform: none; box-shadow: none; }
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
/* 展开态底部一行:左下角用户名胶囊 + 右下角主题切换,space-between 顶到两端 */
.footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
/* 圆角长方体用户名胶囊:头像首字 + 用户名,点击登出。亮于侧栏底色,与会话卡片同层次 */
.user-chip { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 150px; padding: 5px 12px 5px 5px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-sidebar); cursor: pointer; box-shadow: var(--shadow-card); transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease; }
.user-chip:hover { transform: translateY(-1px); box-shadow: var(--shadow-lift); filter: brightness(1.04); }
.user-chip .avatar { flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; }
.user-chip .uname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
/* 头像 + 弹层的定位容器:popover 相对它绝对定位 */
.user-wrap { position: relative; display: inline-flex; }
/* 账户菜单:圆角长方形弹层,浮在头像上方,内含两个圆角长方形按钮 */
.user-menu { position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 50; display: flex; flex-direction: column; gap: 4px; min-width: 132px; padding: 6px; border-radius: 12px; background: var(--bg-elevated); border: 1px solid var(--border); box-shadow: var(--shadow-lift); }
/* 收缩 rail 态:rail 很窄,菜单改浮到头像右侧 */
.rail-menu { bottom: 0; left: calc(100% + 8px); }
.menu-item { text-align: left; background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.menu-item:hover { filter: brightness(1.08); border-color: var(--accent); }
/* 透明全屏背板:点菜单外部关闭。z-index 低于 popover、高于侧栏内容 */
.menu-backdrop { position: fixed; inset: 0; z-index: 40; background: transparent; }
/* 浅/深主题切换圆按钮 */
.theme-toggle { width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer; background: var(--bg-elevated); color: var(--text-sidebar); display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: filter 0.15s ease, color 0.15s ease; }
.theme-toggle .ic { width: 18px; height: 18px; }
.theme-toggle:hover { filter: brightness(1.12); color: var(--accent); }
/* 收缩 rail 态:底部一列(头像在上、主题切换在下),钉到 rail 底部居中 */
.rail-footer { margin-top: auto; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.rail-avatar { width: 32px; height: 32px; border-radius: 50%; border: none; cursor: pointer; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; line-height: 1; flex-shrink: 0; box-shadow: var(--shadow-card); }
.rail-avatar:hover { filter: brightness(1.08); }
</style>
