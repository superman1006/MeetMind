<script setup lang="ts">
import { ref } from "vue";

// busy: 讨论进行中。此时按钮变成方块"打断"键;否则是"发送"键。
// ended: 会话已结束。输入框仍可打字,但回车/点发送会被拦截(emit blocked),不真的发出去。
const props = defineProps<{ busy: boolean; ended: boolean }>();
const emit = defineEmits<{ send: [text: string]; interrupt: []; end: []; blocked: [] }>();
const text = ref("");

function submit(): void {
  const value = text.value.trim();
  if (!value || props.busy) {
    return;
  }
  emit("send", value);
  text.value = "";
}

// 按钮点击:busy 时打断,已结束则拦截弹窗,否则发送。
function onButtonClick(): void {
  if (props.busy) {
    emit("interrupt");
  } else if (props.ended) {
    emit("blocked");
  } else {
    submit();
  }
}

function onKeydown(e: KeyboardEvent): void {
  // 输入法(拼音等)合成中按回车,是上屏候选词而非发送:直接放行,别拦。
  // isComposing 是标准字段;keyCode===229 是部分浏览器/输入法的兜底信号。
  if (e.isComposing || e.keyCode === 229) {
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    // 进行中不发送(要发先打断);已结束则拦截弹窗;否则空闲发送
    if (!props.busy) {
      if (props.ended) {
        emit("blocked");
      } else {
        submit();
      }
    }
  }
}
</script>

<template>
  <div class="composer">
    <textarea
      v-model="text"
      placeholder="输入项目需求… (Enter 发送, Shift+Enter 换行)"
      @keydown="onKeydown"
    ></textarea>
    <button
      :class="{ stop: busy }"
      :title="busy ? '打断当前讨论' : '发送'"
      @click="onButtonClick"
    >
      <span v-if="busy" class="square" aria-label="打断"></span>
      <span v-else>发送</span>
    </button>
    <button
      class="end"
      :disabled="busy || ended"
      :title="ended ? '会议已结束' : '结束会议（仅空闲时可用）'"
      @click="emit('end')"
    >
      结束
    </button>
  </div>
</template>

<style scoped>
.composer { display: flex; gap: 10px; padding: 14px 16px; border-top: 1px solid var(--border); background: var(--bg-chat); align-items: stretch; }
/* 输入框:圆角加大 + 浅阴影,聚焦时强调色描边 + 柔光环 */
textarea { flex: 1; resize: none; height: 56px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; font-size: 14px; line-height: 1.5; font-family: inherit; background: var(--bg-app); color: var(--text-main); box-shadow: var(--shadow-card); outline: none; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
textarea::placeholder { color: var(--text-dim); }
textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
/* 操作按钮:实心强调色,悬浮微微上浮 + 阴影加深 */
button { display: flex; align-items: center; justify-content: center; min-width: 64px; padding: 0 20px; background: var(--accent); color: #fff; border: none; border-radius: 12px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: var(--shadow-card); transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease; }
button:not(:disabled):hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); filter: brightness(1.05); }
button:not(:disabled):active { transform: translateY(0); box-shadow: var(--shadow-card); }
/* 打断态:红色方块按钮 */
button.stop { background: #dc2626; }
.square { width: 14px; height: 14px; background: #fff; border-radius: 3px; }
/* 结束会议按钮:灰色,仅空闲可用 */
button.end { background: #6b7280; min-width: 56px; }
button.end:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
</style>
