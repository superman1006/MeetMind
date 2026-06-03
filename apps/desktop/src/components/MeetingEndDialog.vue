<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
import TypingDots from "./TypingDots.vue";

// 会议结束弹窗:整理中显示进度+转圈(不可关闭);完成/出错后显示结果+关闭按钮。
const props = defineProps<{
  status: "summarizing" | "done" | "error";
  message: string;
  detail?: string;
}>();

const emit = defineEmits<{ close: [] }>();

// 整理中不允许关闭,强制用户等结果。
function tryClose(): void {
  if (props.status !== "summarizing") {
    emit("close");
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    tryClose();
  }
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="overlay" @click="tryClose">
    <div class="dialog" @click.stop>
      <h2 class="title">会议已结束</h2>

      <div v-if="status === 'summarizing'" class="body">
        <p class="message">{{ message }}</p>
        <div class="progress">
          <span v-if="detail" class="detail">{{ detail }}</span>
          <TypingDots />
        </div>
      </div>

      <div v-else-if="status === 'done'" class="body">
        <p class="message">✓ {{ message }}</p>
        <p v-if="detail" class="detail file">{{ detail }}</p>
      </div>

      <div v-else class="body">
        <p class="message err">✗ {{ message }}</p>
      </div>

      <div v-if="status !== 'summarizing'" class="actions">
        <button class="btn confirm" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 复用 ConfirmDialog 的深色弹窗风格 */
.overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.dialog { width: min(440px, calc(100vw - 48px)); background: #2c2c2e; color: #f5f5f7; border-radius: 16px; padding: 24px 24px 18px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45); }
.title { margin: 0 0 12px; font-size: 22px; font-weight: 700; }
.body { margin-bottom: 18px; }
.message { margin: 0 0 12px; font-size: 15px; line-height: 1.5; color: #f5f5f7; }
.message.err { color: #ff6b6b; }
.progress { display: flex; align-items: center; gap: 10px; color: #c7c7cc; }
.detail { font-size: 13px; color: #c7c7cc; }
.detail.file { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #9ca3af; }
.actions { display: flex; justify-content: flex-end; gap: 10px; }
.btn { padding: 9px 18px; border: none; border-radius: 9px; font-size: 14px; font-weight: 600; cursor: pointer; }
.confirm { background: #4f46e5; color: #fff; }
.confirm:hover { background: #4338ca; }
</style>
