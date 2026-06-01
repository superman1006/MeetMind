<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useChatStore } from "../stores/chat.js";
import { rpc } from "../api/rpcClient.js";
import { openEvents } from "../api/sseClient.js";
import MessageBubble from "./MessageBubble.vue";
import Composer from "./Composer.vue";

const props = defineProps<{ sessionId: string }>();
const chat = useChatStore();

const bubbles = computed(() => chat.bubblesOf(props.sessionId));
const busy = computed(() => chat.isBusy(props.sessionId));
const scroller = ref<HTMLElement | null>(null);

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
    onTurnEnd: (p) => chat.endTurn(sessionId, p.turnId, p.used_rag),
    onRoundDone: () => chat.finishRound(sessionId),
    onError: (p) => chat.addErrorBubble(sessionId, p.message),
  });
}

watch(
  () => props.sessionId,
  (id) => {
    chat.ensure(id);
    connect(id);
  },
  { immediate: true },
);

watch(
  () => bubbles.value.map((b) => b.text).join("|"),
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
    </div>
    <Composer :disabled="busy" @send="onSend" />
  </section>
</template>

<style scoped>
.chat { flex: 1; display: flex; flex-direction: column; height: 100vh; }
.scroll { flex: 1; overflow-y: auto; padding: 16px; background: #fff; }
</style>
