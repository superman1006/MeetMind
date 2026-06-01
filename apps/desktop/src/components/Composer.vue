<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ send: [text: string] }>();
const text = ref("");

function submit(): void {
  const value = text.value.trim();
  if (!value || props.disabled) {
    return;
  }
  emit("send", value);
  text.value = "";
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="composer">
    <textarea
      v-model="text"
      :disabled="disabled"
      placeholder="输入项目需求… (Enter 发送, Shift+Enter 换行)"
      @keydown="onKeydown"
    ></textarea>
    <button :disabled="disabled" @click="submit">发送</button>
  </div>
</template>

<style scoped>
.composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e5e7eb; }
textarea { flex: 1; resize: none; height: 56px; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; font-family: inherit; }
button { padding: 0 18px; background: #4f46e5; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
button:disabled { background: #a5b4fc; cursor: not-allowed; }
</style>
