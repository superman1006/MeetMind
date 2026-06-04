<script setup lang="ts">
import { computed, ref } from "vue";
import type { Bubble } from "../stores/chat.js";
import { agentColor } from "../theme/agentColors.js";
import { useUiStore } from "../stores/ui.js";
import TypingDots from "./TypingDots.vue";

const props = defineProps<{ bubble: Bubble }>();
const ui = useUiStore();
// 气泡配色随主题走:浅色用浅底深字,深色用深底亮字。切主题时 ui.theme 变 → 这里自动重算。
const color = computed(() => agentColor(props.bubble.agent_name, ui.theme));

// agent 气泡已建但还没吐出任何 content(Phase 1 工具循环中)→ 显示流动点,表示思考中
const thinking = computed(() => !props.bubble.isUser && props.bubble.text.length === 0);

// 当前展开的工具调用下标(-1 = 没展开)。点按钮切换:点同一个收起,点别的切换。
const openIndex = ref(-1);
function toggle(i: number): void {
  openIndex.value = openIndex.value === i ? -1 : i;
}
// 当前展开的那次调用(下标越界/未展开则为 null)
const openCall = computed(() => {
  const i = openIndex.value;
  if (i < 0 || i >= props.bubble.toolCalls.length) {
    return null;
  }
  return props.bubble.toolCalls[i];
});
// 把入参对象转成一行 JSON 供展示
function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

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
      </div>

      <!-- 工具调用:每次调用一个按钮,点击在正文下方展开该次调用的结果 -->
      <div v-if="bubble.toolCalls.length" class="tools">
        <button
          v-for="(call, i) in bubble.toolCalls"
          :key="i"
          type="button"
          class="tool-btn"
          :class="{ active: openIndex === i }"
          :title="`查看 ${call.name} 的调用结果`"
          @click="toggle(i)"
        >🔧 {{ call.name }}</button>
      </div>

      <TypingDots v-if="thinking" />
      <div v-else class="text">{{ bubble.text }}</div>

      <!-- 工具调用结果面板:点某个按钮后在正文下方展开,显示入参 + 返回结果 -->
      <div v-if="openCall" class="tool-panel">
        <div class="tool-panel-head">
          <span class="tool-panel-name">{{ openCall.name }}</span>
          <span class="tool-panel-args">{{ formatArgs(openCall.args) }}</span>
        </div>
        <pre class="tool-panel-result">{{ openCall.result }}</pre>
      </div>

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
.text { font-size: 14px; line-height: 1.5; }

/* 工具按钮:一排小药丸,每个对应一次工具调用 */
.tools { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.tool-btn {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.8;
  transition: opacity 0.12s, background 0.12s;
}
.tool-btn:hover { opacity: 1; }
.tool-btn.active { background: rgba(0, 0, 0, 0.14); opacity: 1; font-weight: 600; }

/* 结果面板:浅色内嵌卡片,结果超长可滚动 */
.tool-panel {
  margin-top: 8px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 8px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.4);
}
.tool-panel-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-bottom: 6px; }
.tool-panel-name { font-weight: 600; font-size: 12px; }
.tool-panel-args { font-family: ui-monospace, monospace; font-size: 11px; opacity: 0.7; word-break: break-all; }
.tool-panel-result {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, monospace;
  font-size: 11.5px;
  line-height: 1.45;
}

/* 深色主题:气泡改成深底亮字后,工具按钮/结果面板的黑白叠加层要反过来,
   否则浅色面板上的亮字读不清。:root 选中 <html data-theme>,面板在本组件内仍受作用域限定。 */
:root[data-theme="dark"] .tool-btn.active { background: rgba(255, 255, 255, 0.16); }
:root[data-theme="dark"] .tool-panel {
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.07);
}

/* 发送时间:小号、半透明,右对齐挂在气泡底部 */
.time { display: block; margin-top: 4px; font-size: 10px; opacity: 0.6; text-align: right; }
</style>
