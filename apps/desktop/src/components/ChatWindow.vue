<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useChatStore, shouldShowTailThinking } from "../stores/chat.js";
import type { StoredTurn } from "../stores/chat.js";
import { useSessionsStore } from "../stores/sessions.js";
import { rpc } from "../api/rpcClient.js";
import MessageBubble from "./MessageBubble.vue";
import Composer from "./Composer.vue";
import MeetingEndDialog from "./MeetingEndDialog.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import TypingDots from "./TypingDots.vue";

const props = defineProps<{ sessionId: string }>();
const chat = useChatStore();
const sessions = useSessionsStore();

const bubbles = computed(() => chat.bubblesOf(props.sessionId));
const busy = computed(() => chat.isBusy(props.sessionId));
const ended = computed(() => chat.isEnded(props.sessionId));
// 顶部标题:在会话列表里按当前 sessionId 找标题(显式 for,house style)。
const title = computed(() => {
  for (const s of sessions.list) {
    if (s.id === props.sessionId) {
      return s.title;
    }
  }
  return "";
});
const scroller = ref<HTMLElement | null>(null);
// 「会话已结束」提示弹窗开关
const endedNotice = ref(false);
// 会议结束整理弹窗状态:存在 chat store 里按会话区分(由全局 SSE 订阅的 summary_* 事件驱动)。
const summary = computed(() => chat.summaryOf(props.sessionId));

// 尾部「思考中」占位:只在「等下一个 agent 开口」的间隙显示(用户刚发完还没 turn_start、
// 或上一个 agent 已结束还没轮到下一个)。一旦某个 agent 已 turn_start——无论它还在 Phase 1
// 思考(空泡自己显示流动点)还是已经在流式输出(有字)——尾部「思考中」都不再出现。
// 判定逻辑抽到 store 里的纯函数,便于单测;关键是靠 turnEnded 而非 text 区分「正在输出」和「轮次间隙」。
const showThinking = computed(() => shouldShowTailThinking(busy.value, bubbles.value));

// SSE 事件流已由 App.vue 全局订阅(单条 firehose,按 sessionId 路由),这里不再各自建连。

// 打开会话时从 DB 拉历史填充气泡;讨论进行中(busy)则跳过,保留正在流式的本地气泡。
async function loadHistory(sessionId: string): Promise<void> {
  if (!sessionId || chat.isBusy(sessionId)) {
    return;
  }
  try {
    const turns = await rpc<StoredTurn[]>("session.messages", { sessionId });
    chat.load(sessionId, turns);
  } catch (e) {
    chat.addErrorBubble(sessionId, `加载历史失败: ${String(e)}`);
  }
}

// watch 是 Vue 3 的响应式 API：盯着某个会变的值props.sessionId，一变就执行你写的回调
watch(
  () => props.sessionId,
  (id) => {
    chat.ensure(id);
    loadHistory(id);
  },
  { immediate: true },
);

watch(
  () => bubbles.value.map((b) => b.text).join("|") + `|thinking:${showThinking.value}`,
  async () => {
    await nextTick();
    const el = scroller.value;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  },
);


async function onSend(text: string): Promise<void> {
  chat.addUser(props.sessionId, text);
  try {
    //调用 rpcClient 发送POST 请求 需要调用的方法是 chat.send
    await rpc("chat.send", { sessionId: props.sessionId, requirement: text });
  } catch (e) {
    chat.addErrorBubble(props.sessionId, String(e));
  }
}

// 打断当前讨论:后端 abort 本轮 → 推 round_done(interrupted) → finishRound 清 busy → 可重新输入。
async function onInterrupt(): Promise<void> {
  try {
    await rpc("chat.interrupt", { sessionId: props.sessionId });
  } catch (e) {
    chat.addErrorBubble(props.sessionId, String(e));
  }
}

// 结束会议:弹出整理中弹窗,调 chat.end;后续进度/结果由 SSE 的 summary_* 事件驱动弹窗更新。
async function onEnd(): Promise<void> {
  // 点结束即标记会话结束:此后该会话回车/点发送会被 Composer 拦截 → onBlocked 弹提示。
  chat.markEnded(props.sessionId);
  chat.openSummary(props.sessionId);
  try {
    await rpc("chat.end", { sessionId: props.sessionId });
  } catch (e) {
    chat.setSummaryError(props.sessionId, String(e));
  }
}

// 已结束会话仍想发送:不真的发,弹「会话已结束」提示。
function onBlocked(): void {
  endedNotice.value = true;
}
</script>

<template>
  <section class="chat">
    <header class="chat-header">{{ title }}</header>
    <div ref="scroller" class="scroll">
      <!-- 新建会话、用户还没发首条消息:正中间给一句占位提示,而不是空白 -->
      <div v-if="bubbles.length === 0 && !showThinking" class="empty-hint">请输入需求后开始会议</div>
      <MessageBubble v-for="b in bubbles" :key="b.turnId" :bubble="b" />
      <div v-if="showThinking" class="row">
        <div class="thinking-bubble">
          <span class="thinking-label">思考中</span>
          <TypingDots />
        </div>
      </div>
    </div>
    <Composer
      :busy="busy"
      :ended="ended"
      @send="onSend"
      @interrupt="onInterrupt"
      @end="onEnd"
      @blocked="onBlocked"
    />
    <MeetingEndDialog
      v-if="summary.open"
      :status="summary.status"
      :message="summary.message"
      :detail="summary.detail"
      @close="chat.closeSummary(props.sessionId)"
    />
    <ConfirmDialog
      v-if="endedNotice"
      title="会话已结束"
      message="当前会话已结束，无法继续发送消息。"
      confirm-label="知道了"
      hide-cancel
      @confirm="endedNotice = false"
      @cancel="endedNotice = false"
    />
  </section>
</template>

<style scoped>
.chat { flex: 1; display: flex; flex-direction: column; height: 100vh; }
/* 顶部会话标题栏(仿 Claude 桌面端):纤细、左对齐、底部分隔线 */
.chat-header { padding: 12px 16px; font-size: 15px; font-weight: 600; color: var(--text-main); background: var(--bg-chat); border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
.scroll { flex: 1; overflow-y: auto; padding: 16px; background: var(--bg-chat); }
/* 空会话占位:撑满滚动区高度,水平 + 垂直居中 */
.empty-hint { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-size: 15px; }
.row { display: flex; margin: 8px 0; }
.thinking-bubble { display: inline-flex; align-items: center; gap: 8px; max-width: 72%; padding: 10px 12px; border-radius: 12px; background: var(--bg-elevated); color: var(--text-dim); }
.thinking-label { font-size: 12px; }
</style>
