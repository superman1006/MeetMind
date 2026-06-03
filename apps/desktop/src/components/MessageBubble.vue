<script setup lang="ts">
import { computed } from "vue";
import type { Bubble } from "../stores/chat.js";
import { agentColor } from "../theme/agentColors.js";
import TypingDots from "./TypingDots.vue";

const props = defineProps<{ bubble: Bubble }>();
const color = computed(() => agentColor(props.bubble.agent_name));

// agent 气泡已建但还没吐出任何 content(Phase 1 工具循环中)→ 显示流动点,表示思考中
const thinking = computed(() => !props.bubble.isUser && props.bubble.text.length === 0);

// 把 epoch 毫秒格式化成 "2026-6-2 18:23"(年-月-日 时:分,24 小时制,补零到分)。
function two(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
const sentAt = computed(() => {
  const d = new Date(props.bubble.createdAt);
  const date = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return `${date} ${time}`;
});
</script>

<template>
  <div class="row" :class="{ mine: bubble.isUser }">
    <div class="bubble" :style="{ background: color.bg, color: color.fg }">
      <div class="head">
        <span class="role">{{ bubble.role || color.label }}</span>
        <span v-if="bubble.tool" class="tool" :title="`调用了工具 ${bubble.tool}`">UsingTools: {{ bubble.tool }}</span>
      </div>
      <TypingDots v-if="thinking" />
      <div v-else class="text">{{ bubble.text }}</div>
      <!-- 消息发送时间:思考中(还没出内容)不显示,有内容后挂在气泡底部 -->
      <time v-if="!thinking" class="time">{{ sentAt }}</time>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; margin: 8px 0; }
.row.mine { justify-content: flex-end; }
.bubble { max-width: 72%; padding: 10px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
.head { display: flex; gap: 8px; align-items: center; font-size: 12px; opacity: 0.85; margin-bottom: 4px; }
.role { font-weight: 600; }
.tool { font-size: 10px; border: 1px solid currentColor; border-radius: 6px; padding: 0 4px; }
.text { font-size: 14px; line-height: 1.5; }
/* 发送时间:小号、半透明,右对齐挂在气泡底部 */
.time { display: block; margin-top: 4px; font-size: 10px; opacity: 0.6; text-align: right; }
</style>
