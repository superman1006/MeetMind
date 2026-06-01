<script setup lang="ts">
import { ref } from "vue";

// busy: 讨论进行中。此时按钮变成方块"打断"键;否则是"发送"键。
const props = defineProps<{ busy: boolean }>();
const emit = defineEmits<{ send: [text: string]; interrupt: [] }>();
const text = ref("");

function submit(): void {
  const value = text.value.trim();
  if (!value || props.busy) {
    return;
  }
  emit("send", value);
  text.value = "";
}

// 按钮点击:busy 时打断,否则发送。
function onButtonClick(): void {
  if (props.busy) {
    emit("interrupt");
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
    // 进行中不发送(要发先打断);Enter 只在空闲时发送
    if (!props.busy) {
      submit();
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
  </div>
</template>

<style scoped>
.composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e5e7eb; }
textarea { flex: 1; resize: none; height: 56px; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; font-family: inherit; }
button { display: flex; align-items: center; justify-content: center; min-width: 64px; padding: 0 18px; background: #4f46e5; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
button:hover { background: #4338ca; }
/* 打断态:红色方块按钮 */
button.stop { background: #dc2626; }
button.stop:hover { background: #b91c1c; }
.square { width: 14px; height: 14px; background: #fff; border-radius: 3px; }
</style>
