<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useChatStore } from "../stores/chat.js";
import type { StoredTurn } from "../stores/chat.js";
import { rpc } from "../api/rpcClient.js";
import { openEvents } from "../api/sseClient.js";
import MessageBubble from "./MessageBubble.vue";
import Composer from "./Composer.vue";
import TypingDots from "./TypingDots.vue";

const props = defineProps<{ sessionId: string }>();
const chat = useChatStore();

const bubbles = computed(() => chat.bubblesOf(props.sessionId));
const busy = computed(() => chat.isBusy(props.sessionId));
const scroller = ref<HTMLElement | null>(null);

// 尾部「思考中」占位:讨论进行中,且当前没有正在流式的空气泡时显示。
// (空 agent 气泡自己会显示流动点;这里覆盖"刚发完还没 turn_start"和轮次间隙。)
const showThinking = computed(() => {
  if (!busy.value) {
    return false;
  }
  const list = bubbles.value;
  if (list.length === 0) {
    return true;
  }
  const last = list[list.length - 1];
  return last.text.length > 0;
});

// 每个 session 一条 SSE 连接,切换 sessionId 时重连
let es: EventSource | null = null;
function connect(sessionId: string): void {
  if (es) {
    es.close();
    es = null;
  }
  if (!sessionId) {
    return;
  }
  es = openEvents(sessionId, {
    onTurnStart: (p) => chat.startTurn(sessionId, p.turnId, p.agent_name, p.role),
    onDelta: (p) => chat.appendDelta(sessionId, p.turnId, p.text),
    onUsingTools: (p) => chat.useTool(sessionId, p.turnId, p.tool),
    onTurnEnd: (p) => chat.endTurn(sessionId, p.turnId, p.used_rag),
    onRoundDone: () => chat.finishRound(sessionId),
    onError: (p) => chat.addErrorBubble(sessionId, p.message),
  });
}

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

watch(
  () => props.sessionId,
  (id) => {
    chat.ensure(id);
    loadHistory(id);
    connect(id);
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
    await rpc("chat.send", { sessionId: props.sessionId, requirement: text });
  } catch (e) {
    chat.addErrorBubble(props.sessionId, String(e));
  }
}
</script>

<template>
  <section class="chat">
    <div ref="scroller" class="scroll">
      <MessageBubble v-for="b in bubbles" :key="b.turnId" :bubble="b" />
      <div v-if="showThinking" class="row">
        <div class="thinking-bubble">
          <span class="thinking-label">思考中</span>
          <TypingDots />
        </div>
      </div>
    </div>
    <Composer :disabled="busy" @send="onSend" />
  </section>
</template>

<style scoped>
.chat { flex: 1; display: flex; flex-direction: column; height: 100vh; }
.scroll { flex: 1; overflow-y: auto; padding: 16px; background: #fff; }
.row { display: flex; margin: 8px 0; }
.thinking-bubble { display: inline-flex; align-items: center; gap: 8px; max-width: 72%; padding: 10px 12px; border-radius: 12px; background: #f3f4f6; color: #6b7280; }
.thinking-label { font-size: 12px; }
</style>
