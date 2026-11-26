<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { useSessionsStore } from "./stores/sessions.js";
import { useChatStore } from "./stores/chat.js";
import { useAuthStore } from "./stores/auth.js";
import { useUiStore } from "./stores/ui.js";
import { rpc } from "./api/rpcClient.js";
import type { StoredTurn } from "./stores/chat.js";
import { openEvents } from "./api/sseClient.js";
import SessionList from "./components/SessionList.vue";
import ChatWindow from "./components/ChatWindow.vue";
import LoginView from "./components/LoginView.vue";
import Toast from "./components/Toast.vue";

const sessions = useSessionsStore();
const chat = useChatStore();
const auth = useAuthStore();
const ui = useUiStore();

// 拖拽中间分隔条调会话列表宽度:按下后在 document 上挂 pointermove/up,
// 侧栏左边贴着视口左缘(x=0),所以新宽度直接取指针的 clientX(越界由 store 夹紧)。
// pointer 事件比 mouse 更稳(触控板/触屏通吃),拖到对话区上方也不丢事件。
function startResize(e: PointerEvent): void {
  e.preventDefault();
  ui.sidebarResizing = true;
  function onMove(ev: PointerEvent): void {
    ui.setSidebarWidth(ev.clientX);
  }
  function onUp(): void {
    ui.sidebarResizing = false;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  }
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

// B 方案:整个前端只开这一条 SSE 长连(firehose),订阅所有会话。每帧自带 sessionId,
// 这里按 p.sessionId 把事件路由到 chat store 对应会话——后台未展示的会话也能实时收到自己的流。
let es: EventSource | null = null;
function subscribeEvents(): void {
  es = openEvents({
    onConnected: () => void refreshSessions(true),
    onRoundStart: (p) => {
      if (p.resume) chat.beginResume(p.sessionId);
      else chat.addUser(p.sessionId, p.requirement, p.roundId);
      chat.invalidatePlan(p.sessionId);
    },
    onPlanUpdated: (p) => chat.invalidatePlan(p.sessionId),
    onSessionUpdated: () => void refreshSessions(),
    onTurnStart: (p) => chat.startTurn(p.sessionId, p.turnId, p.agent_name, p.role),
    onDelta: (p) => chat.appendDelta(p.sessionId, p.turnId, p.text),
    onUsingTools: (p) => chat.useTool(p.sessionId, p.turnId, p.tool),
    onToolResult: (p) => chat.addToolCall(p.sessionId, p.turnId, { name: p.name, args: p.args, result: p.result }),
    onToolApprovalRequest: (p) => chat.setPendingApproval(p.sessionId, { turnId: p.turnId, approvalId: p.approvalId, tool: p.tool, risk: p.risk }),
    onTurnEnd: (p) => chat.endTurn(p.sessionId, p.turnId, p.used_rag),
    onRoundDone: (p) => {
      chat.finishRound(p.sessionId);
      chat.invalidatePlan(p.sessionId);
      void refreshHistory(p.sessionId);
    },
    onError: (p) => {
      chat.addErrorBubble(p.sessionId, p.message);
      chat.invalidatePlan(p.sessionId);
    },
    onSummaryDone: (p) => {
      chat.setSummaryDone(p.sessionId, p.file);
      void refreshSessions();
    },
    onSummaryError: (p) => {
      chat.setSummaryError(p.sessionId, p.message);
      void refreshSessions();
    },
  });
}

// 断开 SSE 长连(登出 / 应用卸载时调)。
function unsubscribeEvents(): void {
  if (es) {
    es.close();
    es = null;
  }
}

// 请求返回时再次核对账号和会话忙碌状态，避免历史记录覆盖正在推送的气泡。
async function refreshHistory(sessionId: string): Promise<void> {
  const username = auth.username;
  try {
    const turns = await rpc<StoredTurn[]>("session.messages", { sessionId });
    if (username && auth.username === username && !chat.isBusy(sessionId)) chat.load(sessionId, turns);
  } catch (error) {
    if (auth.loggedIn) ui.showToast(String(error));
  }
}

// SSE 连上或重连时对照服务端状态，补齐错过的历史、会话状态和恢复入口。
async function refreshSessions(refreshActive = false): Promise<void> {
  try {
    await sessions.load();
    chat.hydrateEnded(sessions.list);
    if (refreshActive && auth.loggedIn) {
      const id = sessions.activeId;
      const active = sessions.list.find((meeting) => meeting.id === id);
      if (!active) return;
      chat.invalidatePlan(id);
      if (!active.running) chat.finishRound(id);
      if (!chat.isBusy(id)) await refreshHistory(id);
      if (active.running && !chat.isBusy(id)) chat.beginResume(id);
      if (!active.running && active.isHost && !active.ended && !active.archived) {
        const state = await rpc<{ resumable: boolean }>("chat.getResumable", { sessionId: id });
        if (state.resumable && !chat.isBusy(id)) chat.setResumable(id, []);
      }
    }
  } catch (error) {
    if (auth.loggedIn) ui.showToast(String(error));
  }
}

async function enterSession(): Promise<void> {
  if (es) return;
  subscribeEvents();
  await refreshSessions();
}

function leaveSession(): void {
  unsubscribeEvents();
  sessions.$reset();
  chat.$reset();
}

// 监听登录态:已登录(含刷新后从 localStorage 恢复)→ 进会话界面;登出 → 收尾。
// immediate 让首帧就根据恢复出来的登录态决定是否初始化,无需在 onMounted 里重复判断。
watch(
  () => auth.loggedIn,
  (loggedIn) => {
    if (loggedIn) {
      enterSession();
    } else {
      leaveSession();
    }
  },
  { immediate: true },
);

// 应用卸载时断开这条长连(单窗口 demo 基本是整页关闭,顺手收尾)。
onBeforeUnmount(() => {
  unsubscribeEvents();
});
</script>

<template>
  <!-- 未登录:登录页;登录后:会话界面。Toast 常驻顶层,两种状态都能弹(登录失败提示也靠它)。 -->
  <LoginView v-if="!auth.loggedIn" class="app" />
  <div v-else class="app" :class="{ resizing: ui.sidebarResizing }">
    <SessionList />
    <!-- 会话列表与对话窗口之间的可拖拽分隔条:按住左右拖即可自定义列表宽度。收缩成 rail 时隐藏。 -->
    <div
      v-if="!ui.sidebarCollapsed"
      class="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖拽调节会话列表宽度"
      @pointerdown="startResize"
    ></div>
    <ChatWindow v-if="sessions.activeId" :session-id="sessions.activeId" />
    <section v-else class="empty">点击「+ 新会话」开始</section>
  </div>
  <Toast />
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
/* 分隔条:本体只有 5px 细缝,贴在侧栏右缘;flex-shrink:0 不被挤压,col-resize 提示可拖。 */
.resizer { flex-shrink: 0; width: 5px; cursor: col-resize; background: var(--border); position: relative; transition: background 0.15s ease; }
.resizer:hover { background: var(--accent); }
/* 用伪元素把可点中的热区向两侧各扩 4px,真正能抓到的范围比那道细缝宽,好对准。 */
.resizer::before { content: ""; position: absolute; top: 0; bottom: 0; left: -4px; right: -4px; }
/* 拖拽时强制全局 col-resize 光标,并禁掉选中,避免拖过文字时选中一片。 */
.app.resizing { cursor: col-resize; user-select: none; }
.app.resizing .resizer { background: var(--accent); }
</style>
