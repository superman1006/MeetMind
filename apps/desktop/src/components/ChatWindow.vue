<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useChatStore, shouldShowTailThinking } from "../stores/chat.js";
import type { StoredTurn } from "../stores/chat.js";
import { useSessionsStore } from "../stores/sessions.js";
import { rpc } from "../api/rpcClient.js";
import { logUserAction } from "../api/logger.js";
import MessageBubble from "./MessageBubble.vue";
import Composer from "./Composer.vue";
import ToolApprovalBar from "./ToolApprovalBar.vue";
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
// Composer 子组件引用:切换/新建会话时主动聚焦其输入框,让用户直接打字。
const composer = ref<InstanceType<typeof Composer> | null>(null);
// 「会话已结束」提示弹窗开关
const endedNotice = ref(false);
// 会议结束整理弹窗状态:存在 chat store 里按会话区分(由全局 SSE 订阅的 summary_* 事件驱动)。
const summary = computed(() => chat.summaryOf(props.sessionId));
// 挂起的工具审批(risk>low 的工具执行前):有值则输入框上方弹审批条。
const pendingApproval = computed(() => chat.pendingApprovalOf(props.sessionId));
// 是否有崩溃残留的未完成轮可恢复（探测后由 chat store 置位）。
const resumable = computed(() => chat.isResumable(props.sessionId));

// 尾部「思考中」占位:只在「等下一个 agent 开口」的间隙显示(用户刚发完还没 turn_start、
// 或上一个 agent 已结束还没轮到下一个)。一旦某个 agent 已 turn_start——无论它还在 Phase 1
// 思考(空泡自己显示流动点)还是已经在流式输出(有字)——尾部「思考中」都不再出现。
// 判定逻辑抽到 store 里的纯函数,便于单测;关键是靠 turnEnded 而非 text 区分「正在输出」和「轮次间隙」。
const showThinking = computed(() => shouldShowTailThinking(busy.value, bubbles.value));

// 上下文用量估算:本会话所有气泡正文的字符数累加,作为「上下文大小」的近似(粗略当 token 用)。
// 传给 Composer 驱动圆环 + 80% 压缩触发。注意这是「展示侧」的全量大小估算,只用来做触发信号。
const contextUsed = computed(() => {
  let total = 0;
  for (const b of bubbles.value) {
    total += b.text.length;
  }
  return total;
});

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

// 打开会话时探测是否有可恢复的未完成轮；有则把崩溃前发言渲染出来并弹「继续」。
async function checkResumable(sessionId: string): Promise<void> {
  if (!sessionId || chat.isBusy(sessionId) || chat.isEnded(sessionId)) {
    return;
  }
  try {
    const res = await rpc<{ resumable: boolean; pendingTurns?: StoredTurn[] }>(
      "chat.getResumable",
      { sessionId },
    );
    if (res.resumable && res.pendingTurns && res.pendingTurns.length > 0) {
      chat.setResumable(sessionId, res.pendingTurns);
    }
  } catch {
    // 探测失败静默忽略，不影响正常使用。
  }
}

// watch 是 Vue 3 的响应式 API：盯着某个会变的值props.sessionId，一变就执行你写的回调
watch(
  () => props.sessionId,
  async (id) => {
    chat.ensure(id);
    // 先 load（会整体替换气泡），再探测续跑（在其后追加崩溃前发言），顺序不能反。
    await loadHistory(id);
    // 每个 await 后校验会话没被切走：快速切换时晚到的 checkResumable 不能把 stale 数据写进别的会话。
    if (props.sessionId !== id) {
      return;
    }
    await checkResumable(id);
    if (props.sessionId !== id) {
      return;
    }
    await nextTick();
    composer.value?.focus();
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
  logUserAction("发送消息", { sessionId: props.sessionId, length: text.length });
  // 是否本会话首条消息:addUser 前本地零气泡 = 新会话第一次发言(重开带历史的会话气泡非空)。
  const isFirst = chat.bubblesOf(props.sessionId).length === 0;
  chat.addUser(props.sessionId, text);
  // 首条消息:并行 fire 一个标题摘要请求(不 await、不阻塞下面的 chat.send,与架构师讨论并行),
  // 后端用 LLM 把输入总结成短标题并写库,拿到后回填前端会话标题。失败/空标题静默忽略,保留默认标题。
  if (isFirst) {
    const sid = props.sessionId;  // 捕获当前会话 id:请求在途时用户可能已切走,回填要认准这条会话。
    rpc<{ ok: boolean; title?: string }>("chat.summaryTitle", { sessionId: sid, requirement: text })
      .then((res) => {
        if (res.ok && res.title) {
          sessions.setTitle(sid, res.title);
        }
      })
      .catch(() => {
        // 标题摘要失败不影响讨论,什么都不做。
      });
  }
  try {
    //调用 rpcClient 发送POST 请求 需要调用的方法是 chat.send
    await rpc("chat.send", { sessionId: props.sessionId, requirement: text });
  } catch (e) {
    chat.addErrorBubble(props.sessionId, String(e));
  }
}

// 打断当前讨论:后端 abort 本轮 → 推 round_done(interrupted) → finishRound 清 busy → 可重新输入。
async function onInterrupt(): Promise<void> {
  logUserAction("打断讨论", { sessionId: props.sessionId });
  try {
    await rpc("chat.interrupt", { sessionId: props.sessionId });
  } catch (e) {
    chat.addErrorBubble(props.sessionId, String(e));
  }
}

// 点「继续」：从崩溃残留的 checkpoint 续跑未完成轮（发言经既有 SSE 流式进来）。
async function onResume(): Promise<void> {
  logUserAction("继续未完成轮次", { sessionId: props.sessionId });
  // beginResume 同步置 busy 并清 resumable：提示条立刻消失、输入框切到「打断」。
  chat.beginResume(props.sessionId);
  try {
    await rpc("chat.resume", { sessionId: props.sessionId });
  } catch (e) {
    // 恢复请求本身失败：addErrorBubble 会清 busy；resumable 已被 beginResume 清掉、不再弹提示，
    // 会话回到「可正常发新消息」的状态（不重置 resumable 是有意的）。
    chat.addErrorBubble(props.sessionId, String(e));
  }
}

// 点「放弃」：丢弃崩溃残留的未完成轮——前端删掉未落库的 resume 气泡 + 清提示条，
// 后端清掉在途 thread 标记 + 删 checkpoint（之后重开本会话不再弹「继续」提示）。
async function onDiscard(): Promise<void> {
  logUserAction("放弃未完成轮次", { sessionId: props.sessionId });
  // 先同步清前端态：提示条消失、resume 气泡移除、输入框解锁。
  chat.discardResumable(props.sessionId);
  try {
    await rpc("chat.discardResumable", { sessionId: props.sessionId });
  } catch (e) {
    // 后端清理失败也不回滚前端：本会话本次已可正常发新消息；只是下次重开可能再探到残留。
    chat.addErrorBubble(props.sessionId, String(e));
  }
}

// 结束会议:弹出整理中弹窗,调 chat.end;后续进度/结果由 SSE 的 summary_* 事件驱动弹窗更新。
async function onEnd(): Promise<void> {
  logUserAction("结束会议", { sessionId: props.sessionId });
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

// 上下文用量越过 80%（Composer 发 compact 事件）：请求后端压缩。
// 后端只改 sessions 的摘要 + 边界,messages 全量不动 → 前端展示历史无需重载。失败静默忽略,不打断讨论。
async function onCompact(): Promise<void> {
  const sid = props.sessionId;  // 捕获当前会话 id:请求在途时用户可能切走。
  logUserAction("请求压缩上下文", { sessionId: sid });
  try {
    const res = await rpc<{ compacted: boolean; reason?: string }>("chat.compact", { sessionId: sid });
    if (res.compacted) {
      logUserAction("上下文已压缩", { sessionId: sid });
    }
  } catch {
    // 压缩失败不影响讨论,什么都不做。
  }
}

// 用户对工具审批拍板:先乐观清掉审批条,再把决策回传 runtime(method=toolApproval)。
async function onApprovalDecide(approved: boolean): Promise<void> {
  const p = pendingApproval.value;
  if (!p) {
    return;
  }
  logUserAction("工具审批", { sessionId: props.sessionId, tool: p.tool, risk: p.risk, approved });
  chat.clearPendingApproval(props.sessionId);
  try {
    await rpc("toolApproval", { approvalId: p.approvalId, approved });
  } catch (e) {
    chat.addErrorBubble(props.sessionId, String(e));
  }
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
    <div v-if="resumable && !busy && !ended" class="resume-bar" role="status" aria-live="polite">
      <span class="resume-text">上一轮讨论未完成（可能因服务重启中断），请选择继续或放弃后再输入。</span>
      <div class="resume-actions">
        <button class="resume-btn discard" @click="onDiscard">放弃</button>
        <button class="resume-btn" @click="onResume">继续</button>
      </div>
    </div>
    <ToolApprovalBar
      v-if="pendingApproval"
      :tool="pendingApproval.tool"
      :risk="pendingApproval.risk"
      @decide="onApprovalDecide"
    />
    <Composer
      ref="composer"
      :busy="busy"
      :ended="ended"
      :locked="resumable && !busy && !ended"
      :context-used="contextUsed"
      @send="onSend"
      @interrupt="onInterrupt"
      @end="onEnd"
      @blocked="onBlocked"
      @compact="onCompact"
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
.resume-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; background: var(--accent-soft); border-top: 1px solid var(--border); }
.resume-text { font-size: 13px; color: var(--text-main); }
.resume-actions { flex-shrink: 0; display: flex; gap: 8px; }
.resume-btn { flex-shrink: 0; padding: 6px 14px; border: none; border-radius: 8px; background: var(--accent); color: #fff; font-size: 13px; cursor: pointer; }
.resume-btn:hover { opacity: 0.9; }
/* 放弃:灰底次要按钮,和「继续」区分 */
.resume-btn.discard { background: #6b7280; }
</style>
