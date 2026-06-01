<script setup lang="ts">
import { computed } from "vue";
import type { Bubble } from "../stores/chat.js";
import { agentColor } from "../theme/agentColors.js";
import TypingDots from "./TypingDots.vue";

const props = defineProps<{ bubble: Bubble }>();
const color = computed(() => agentColor(props.bubble.agent_name));

// agent 气泡已建但还没吐出任何 content(Phase 1 工具循环中)→ 显示流动点,表示思考中
const thinking = computed(() => !props.bubble.isUser && props.bubble.text.length === 0);
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
</style>
