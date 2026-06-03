# Desktop UI 三项调整 实现计划

> 执行方式：用户授权自主执行到完成。改动均为耦合的前端文件，由单一执行者顺序实现（避免并行子代理在共享文件冲突），每个 Task 末尾 `vue-tsc` typecheck 作为 checkpoint；不提交。

**Goal:** 结束会话后拦截发送 + 全应用浅/深主题切换 + 聊天窗口顶部标题栏。

**Tech Stack:** Vue 3 `<script setup lang="ts">` + Pinia + vite。CSS 变量做主题。

**通用命令:** `pnpm --filter @meetmind/desktop typecheck`

文件每个只触一次（主题色变量化并入各组件自己的 Task）。

---

## Task A: 主题基础（ui store + main.ts + App.vue 变量）

**Files:** `stores/ui.ts`, `main.ts`, `App.vue`

- [ ] **ui store** 加 theme：
```ts
import { defineStore } from "pinia";

export const useUiStore = defineStore("ui", {
  state: () => ({
    sidebarCollapsed: false,
    theme: "light" as "light" | "dark",
  }),
  actions: {
    toggleSidebar(): void {
      this.sidebarCollapsed = !this.sidebarCollapsed;
    },
    // 把当前主题写到 <html data-theme>，CSS 变量据此级联。
    applyTheme(): void {
      document.documentElement.setAttribute("data-theme", this.theme);
    },
    // 启动时调用：从 localStorage 恢复主题（默认 light），并应用。
    initTheme(): void {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem("meetmind-theme");
      } catch {
        saved = null;
      }
      this.theme = saved === "dark" ? "dark" : "light";
      this.applyTheme();
    },
    toggleTheme(): void {
      this.theme = this.theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("meetmind-theme", this.theme);
      } catch {
        // 隐私模式等 localStorage 不可用：忽略持久化，不抛错
      }
      this.applyTheme();
    },
  },
});
```
- [ ] **main.ts**：在 `app.mount(...)` 之前，`createPinia()` 装载之后，调 `useUiStore().initTheme()`（防首帧闪烁）。读当前 main.ts 确认 pinia 安装位置后插入。
- [ ] **App.vue** 非 scoped `<style>`：定义两套变量 + body 用变量；`.empty` 的 `color: #9ca3af` → `var(--text-dim)`：
```css
:root {
  --bg-app: #ffffff; --bg-sidebar: #f3f4f6; --bg-chat: #ffffff; --bg-elevated: #f3f4f6;
  --text-main: #111827; --text-dim: #6b7280; --text-sidebar: #1f2937;
  --border: #e5e7eb; --accent: #4f46e5;
}
:root[data-theme="dark"] {
  --bg-app: #1a1a1b; --bg-sidebar: #111827; --bg-chat: #1e1e20; --bg-elevated: #2a2a2d;
  --text-main: #f3f4f6; --text-dim: #9ca3af; --text-sidebar: #e5e7eb;
  --border: #374151; --accent: #6366f1;
}
body { background: var(--bg-app); color: var(--text-main); }
```
- [ ] **Checkpoint:** `pnpm --filter @meetmind/desktop typecheck` 过。

---

## Task B: chat store ended 状态 + ConfirmDialog hideCancel

**Files:** `stores/chat.ts`, `components/ConfirmDialog.vue`

- [ ] **chat store**：`ChatState` 加 `endedBySession: Record<string, boolean>`；state 初始化 `endedBySession: {}`；getters 加 `isEnded: (state) => (sessionId: string) => state.endedBySession[sessionId] ?? false`；actions 加：
```ts
    markEnded(sessionId: string): void {
      this.endedBySession[sessionId] = true;
    },
```
`drop(sessionId)` 里追加 `delete this.endedBySession[sessionId];`。
- [ ] **ConfirmDialog.vue**：props 加可选 `hideCancel?: boolean`（`withDefaults` 默认 `false`）；模板取消按钮加 `v-if="!hideCancel"`。其余不变。
- [ ] **Checkpoint:** typecheck 过。

---

## Task C: Composer ended 拦截 + 颜色变量化

**Files:** `components/Composer.vue`

- [ ] props 加 `ended`：`const props = defineProps<{ busy: boolean; ended: boolean }>();`
- [ ] emits 加 blocked：`const emit = defineEmits<{ send: [text: string]; interrupt: []; end: []; blocked: [] }>();`
- [ ] `onButtonClick` 改：
```ts
function onButtonClick(): void {
  if (props.busy) {
    emit("interrupt");
  } else if (props.ended) {
    emit("blocked");
  } else {
    submit();
  }
}
```
- [ ] `onKeydown` 的 Enter 分支改（非 busy 时）：
```ts
    if (!props.busy) {
      if (props.ended) {
        emit("blocked");
      } else {
        submit();
      }
    }
```
（blocked 不调用 submit → 不清空输入框，保留已输入文本。）
- [ ] 颜色变量化：`.composer` 顶边 `var(--border)` + 背景 `var(--bg-chat)`；`textarea` 背景 `var(--bg-app)`、文字 `var(--text-main)`、边框 `var(--border)`；主发送按钮背景用 `var(--accent)`（hover 略深可保留或用 accent）；打断 `.stop` 红、`.end` 灰保持不变。
- [ ] **Checkpoint:** typecheck 过。

---

## Task D: ChatWindow 接线（拦截 + 标题栏 + 颜色变量化）

**Files:** `components/ChatWindow.vue`

- [ ] import：加 `import ConfirmDialog from "./ConfirmDialog.vue";` 和 `import { useSessionsStore } from "../stores/sessions.js";`；`computed` 已 import（确认）。
- [ ] 加 `const sessions = useSessionsStore();`。
- [ ] 派生标题（显式 for，house style）：
```ts
const title = computed(() => {
  for (const s of sessions.list) {
    if (s.id === props.sessionId) {
      return s.title;
    }
  }
  return "";
});
```
- [ ] 派生 ended：`const ended = computed(() => chat.isEnded(props.sessionId));`
- [ ] `const endedNotice = ref(false);`
- [ ] `onEnd()` 开头加 `chat.markEnded(props.sessionId);`
- [ ] 加 `function onBlocked(): void { endedNotice.value = true; }`
- [ ] 模板：
  - `.chat` 内、`.scroll` 前加：`<header class="chat-header">{{ title }}</header>`
  - `<Composer>` 加 `:ended="ended"` 和 `@blocked="onBlocked"`
  - 末尾加：
```html
    <ConfirmDialog
      v-if="endedNotice"
      title="会话已结束"
      message="当前会话已结束，无法继续发送消息。"
      confirm-label="知道了"
      hide-cancel
      @confirm="endedNotice = false"
      @cancel="endedNotice = false"
    />
```
- [ ] 样式：加 `.chat-header { padding: 12px 16px; font-size: 15px; font-weight: 600; color: var(--text-main); background: var(--bg-chat); border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`；`.scroll` 背景 → `var(--bg-chat)`；`.thinking-bubble` 背景 → `var(--bg-elevated)`、文字 → `var(--text-dim)`。
- [ ] **Checkpoint:** typecheck 过。

---

## Task E: SessionList 主题按钮 + 颜色变量化

**Files:** `components/SessionList.vue`

- [ ] script 已有 `const ui = useUiStore();`（确认）。
- [ ] 展开态模板：`.list` 之后、`</aside>` 之前加底部圆按钮：
```html
    <button class="theme-toggle" :title="ui.theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="ui.toggleTheme()">
      {{ ui.theme === "dark" ? "☀️" : "🌙" }}
    </button>
```
- [ ] 收缩 rail 态：展开按钮之后加同款（可共用 class）圆按钮（同上）。
- [ ] 样式：`.list` 加 `flex: 1;`（把按钮顶到底）；`.sidebar` 已 flex column。加：
```css
.theme-toggle { align-self: flex-end; margin-top: 8px; width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer; font-size: 18px; background: var(--bg-elevated); color: var(--text-sidebar); display: flex; align-items: center; justify-content: center; }
.theme-toggle:hover { filter: brightness(1.1); }
.rail .theme-toggle, .rail-toggle { align-self: center; margin-top: auto; }
```
（rail 里给按钮 `margin-top:auto` 顶到底、居中。）
- [ ] 颜色变量化：`.sidebar`/`.rail` 背景 `var(--bg-sidebar)` + 文字 `var(--text-sidebar)`；`.toggle`/`.new` 背景 `var(--bg-elevated)`；`.list li.active, .list li:hover` 背景 `var(--bg-elevated)`；`.icon` 文字 `var(--text-dim)`；`.rename-input` 背景 `var(--bg-app)` + 文字 `var(--text-main)` + 边框 `var(--accent)`。保证浅/深都清楚可读。
- [ ] **Checkpoint:** typecheck 过。

---

## Task F: 验证

- [ ] `pnpm --filter @meetmind/desktop typecheck` 整体过。
- [ ] `pnpm --filter @meetmind/runtime typecheck`（应不受影响，确认未误触）。
- [ ] 派一个前端 code-review 子代理审整份 diff（spec 符合度 + 质量 + 浅/深可读性 + 无 smart quotes）。
- [ ] 起 runtime(3002) + desktop(5173)，用 Playwright 冒烟：截图浅色 → 点圆按钮 → 截图深色（侧边栏+聊天区+输入框整体变色）；确认顶部标题显示、切会话标题更新；刷新后主题保持。send-block 逻辑简单且已审，主要靠 typecheck + 代码审查保证（活测受整理弹窗遮挡，不强求）。

## 自检对照
- ended 拦截：Task B（store）+ C（Composer 拦截）+ D（markEnded/onBlocked/notice）。
- 主题：Task A（基础）+ C/D/E（各组件变量化 + 按钮）。
- 标题：Task D。
- 命名一致：`isEnded`/`markEnded`/`endedBySession`、`theme`/`toggleTheme`/`initTheme`/`applyTheme`、`hideCancel`、`--bg-*`/`--text-*`/`--border`/`--accent` 跨 Task 一致。
