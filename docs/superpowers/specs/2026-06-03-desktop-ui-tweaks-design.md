# Desktop UI 三项调整 — 设计文档

日期: 2026-06-03
分支: ts-dev
状态: 自主执行中（用户授权遇选择自行判断，直到完成；用户复核环节按授权豁免）

## 目标

在已实现「结束会议」功能之后，对 desktop 前端做三项调整：

1. **拦截已结束会话的发送**（bug 修复）：点「结束」后，输入框仍可输入，但回车 / 点发送会被拦截并弹出「当前会话已结束」提示，而不是真的发出去。
2. **浅/深色主题切换**：左侧会话列表右下角加一个圆形按钮，切换浅色 / 深色主题（全应用，含侧边栏）。
3. **聊天窗口顶部会话标题**：在聊天区正上方加一条标题栏显示当前会话标题（仿 Claude 桌面端，仅展示）。

均为纯前端改动，不动 runtime。

## 决策（已锁定）

| 决策点 | 结论 |
|---|---|
| 主题覆盖范围 | 全应用：侧边栏 + 聊天区 + 输入框 + 标题栏都随主题切换（用 CSS 变量） |
| 浅色下侧边栏 | 也变浅（light sidebar），不再固定深色 |
| 「会话已结束」持久化 | 仅前端内存（`chat` store），刷新 / 重启 app 后重置；不改后端 |
| ended 触发时机 | 点「结束」即标记（`onEnd` 里 `markEnded`），满足「点击后即拦截」 |
| 拦截弹窗 | 复用 `ConfirmDialog`，新增 `hideCancel` prop → 单按钮「知道了」 |
| 标题栏 | 仅展示，左对齐，纤细顶栏；重命名仍在侧边栏 |
| 主题默认 / 持久化 | 默认 `light`；存 `localStorage` 键 `meetmind-theme`；`main.ts` 在 mount 前应用防闪烁 |

## 改动一：拦截已结束会话的发送

### chat store（`stores/chat.ts`）
- state 加 `endedBySession: Record<string, boolean>`。
- getter `isEnded(sessionId)` → bool。
- action `markEnded(sessionId)` → 置 true。
- `drop(sessionId)` 里删除 `endedBySession[sessionId]`（删会话时清理）。

### Composer（`components/Composer.vue`）
- 新增 prop `ended: boolean`。
- 新增 emit `blocked: []`。
- `onButtonClick`：`busy` → `emit('interrupt')`；否则 `ended` → `emit('blocked')`；否则 `submit()`。
- `onKeydown`（Enter 且非 busy）：`ended` → `emit('blocked')`；否则 `submit()`。
- 关键：`blocked` 分支**不调用 `submit()`**，因此**不清空 `text`**（保留用户已输入内容）。`submit()` 内部维持原逻辑（成功发送才 `text.value=""`）。

### ChatWindow（`components/ChatWindow.vue`）
- `onEnd()` 开头加 `chat.markEnded(props.sessionId)`。
- 计算属性 `ended = computed(() => chat.isEnded(props.sessionId))`，传给 `<Composer :ended="ended">`。
- 新增 `endedNotice = ref(false)`；`onBlocked()` 置 `endedNotice.value = true`。
- 模板：`<Composer ... @blocked="onBlocked">`；末尾加一个复用 `ConfirmDialog` 的提示弹窗（见下）。

### ConfirmDialog（`components/ConfirmDialog.vue`）
- 新增可选 prop `hideCancel?: boolean`（默认 `false`，向后兼容）。
- 模板里 `v-if="!hideCancel"` 控制取消按钮显隐；`hideCancel` 时点遮罩 = 确认关闭（或忽略，统一用确认）。
- ended 提示用法：`<ConfirmDialog v-if="endedNotice" title="会话已结束" message="当前会话已结束，无法继续发送消息。" confirm-label="知道了" hide-cancel @confirm="endedNotice=false" @cancel="endedNotice=false" />`。

## 改动二：浅/深色主题切换

### ui store（`stores/ui.ts`）
- state 加 `theme: "light" | "dark"`（初值 `"light"`，实际值由 `initTheme` 覆盖）。
- `initTheme()`：读 `localStorage.getItem("meetmind-theme")`，合法则用之否则 `"light"`，写入 `this.theme` 并 `applyTheme()`。
- `applyTheme()`：`document.documentElement.setAttribute("data-theme", this.theme)`。
- `toggleTheme()`：翻转 `this.theme`，`localStorage.setItem("meetmind-theme", this.theme)`，`applyTheme()`。

### main.ts
- 创建 pinia、app 之后、`app.mount()` **之前**，取 `useUiStore()` 调 `initTheme()`，避免首帧闪烁。

### App.vue 全局样式定义变量
非 scoped `<style>` 里：
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
`.empty` 的 `color` 换成 `var(--text-dim)`。

### 各组件颜色变量化
- **SessionList.vue**：`.sidebar`/`.rail` 背景 `var(--bg-sidebar)`、文字 `var(--text-sidebar)`；`.toggle`/`.new`/`li.active`/`li:hover` 用 `var(--bg-elevated)` / hover 提亮；`.rename-input` 用 `var(--bg-app)` + `var(--text-main)` + `var(--accent)` 边框。具体取值实现时按可读性微调，保证浅/深都清楚。
- **ChatWindow.vue**：`.scroll` 背景 `var(--bg-chat)`；`.thinking-bubble` 背景 `var(--bg-elevated)`、文字 `var(--text-dim)`；新 `.chat-header` 用 `var(--bg-chat)` + `var(--border)` 底边 + `var(--text-main)`。
- **Composer.vue**：`.composer` 顶边 `var(--border)`、背景 `var(--bg-chat)`；`textarea` 背景 `var(--bg-app)` + 文字 `var(--text-main)` + 边框 `var(--border)`；发送按钮保持 indigo（可用 `var(--accent)`），打断红、结束灰保持不变。
- **不动**：MessageBubble（气泡用 `agentColor` 上色，两套主题通用）、TypingDots（`currentColor`）、深色浮层 ConfirmDialog / MeetingEndDialog（浮层常态深色，两套都保持）。

### 切换按钮（SessionList.vue）
- 圆形按钮：`width/height:40px; border-radius:50%`，图标 `theme==='dark' ? '☀️' : '🌙'`，`title` 同步（暗色时「切换到浅色」反之）。
- 展开态：`.list` 设 `flex:1` 撑开，按钮放在列表之后、钉在侧边栏底部、右对齐（`align-self:flex-end` 或外层 `justify-content`）。
- 收缩 rail 态：底部也放一个同款圆按钮（居中）。
- 点击 `@click="ui.toggleTheme()"`。

## 改动三：聊天窗口顶部会话标题

### ChatWindow.vue
- 引入 `useSessionsStore()`；计算 `title`：显式 for 循环在 `sessions.list` 里找 `id === props.sessionId` 的 `title`，找不到回退空串或「会话」。
- 模板：`.chat` 内、`.scroll` 之前加 `<header class="chat-header">{{ title }}</header>`。
- 样式：纤细顶栏（padding ~12px 16px、`font-size:15px`、`font-weight:600`、底部 `1px solid var(--border)`、背景 `var(--bg-chat)`、文字 `var(--text-main)`，左对齐，单行省略）。

## 架构 / 数据流要点

- 主题：单一真相在 `ui.theme` + `<html data-theme>`；所有颜色经 CSS 变量级联，组件零散色值集中到 App.vue 两套调色板。
- ended：单一真相在 `chat.endedBySession`；ChatWindow 读它派生 `ended` 传给 Composer；Composer 只负责「拦截并上报 blocked」，弹窗由 ChatWindow 拥有。
- 标题：派生自 `sessions` store，无新状态。

## 错误处理 / 边界

- 整理中（MeetingEndDialog 模态遮罩覆盖全屏）用户点不到 Composer；弹窗关闭后会话已 ended，发送被拦截。两个弹窗（整理弹窗、ended 提示）不会同时需要交互。
- 刷新 / 切走再回来：ended 是内存态会重置 → 可再次发送 / 再次结束（可接受，demo 行为）。
- 主题：`localStorage` 不可用（隐私模式）时 `initTheme` 的 try 兜底为默认 light，不抛错。
- 标题为空（未知会话）时标题栏显示空或「会话」，不崩。

## 测试

- 类型：`pnpm --filter @meetmind/desktop typecheck`（vue-tsc）必须过。
- 手动 / Playwright 冒烟：① 切主题，侧边栏 + 聊天区 + 输入框整体浅↔深，刷新后保持；② 顶部显示当前会话标题，切会话标题更新；③ 点「结束」后在输入框打字 + 回车 / 点发送 → 弹「会话已结束」、消息未发出、输入内容仍在。
- 无纯逻辑新函数，不加前端单测（项目 desktop 侧无测试框架）。

## 涉及文件

修改：
- `apps/desktop/src/stores/chat.ts`（ended 状态）
- `apps/desktop/src/stores/ui.ts`（theme 状态）
- `apps/desktop/src/main.ts`（initTheme 防闪烁）
- `apps/desktop/src/App.vue`（CSS 变量两套 + body/.empty 变量化 + 主题应用）
- `apps/desktop/src/components/Composer.vue`（ended prop + blocked emit + 颜色变量化）
- `apps/desktop/src/components/ChatWindow.vue`（markEnded + ended 派生 + onBlocked + 标题栏 + 通知弹窗 + 颜色变量化）
- `apps/desktop/src/components/SessionList.vue`（主题切换圆按钮 + 颜色变量化）
- `apps/desktop/src/components/ConfirmDialog.vue`（+`hideCancel` prop）

基本不动：`components/MessageBubble.vue`、`components/TypingDots.vue`、`components/MeetingEndDialog.vue`。
