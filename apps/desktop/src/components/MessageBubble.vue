<script setup lang="ts">
import { computed } from "vue";
import type { Bubble } from "../stores/chat.js";
import { agentColor } from "../theme/agentColors.js";

const props = defineProps<{ bubble: Bubble }>();
const color = computed(() => agentColor(props.bubble.agent_name));
</script>

<template>
  <div class="row" :class="{ mine: bubble.isUser }">
    <div class="bubble" :style="{ background: color.bg, color: color.fg }">
      <div class="head">
        <span class="role">{{ bubble.role || color.label }}</span>
        <span v-if="bubble.used_rag" class="rag">RAG</span>
      </div>
      <div class="text">{{ bubble.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; margin: 8px 0; }
.row.mine { justify-content: flex-end; }
.bubble { max-width: 72%; padding: 10px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
.head { display: flex; gap: 8px; align-items: center; font-size: 12px; opacity: 0.85; margin-bottom: 4px; }
.role { font-weight: 600; }
.rag { font-size: 10px; border: 1px solid currentColor; border-radius: 6px; padding: 0 4px; }
.text { font-size: 14px; line-height: 1.5; }
</style>
