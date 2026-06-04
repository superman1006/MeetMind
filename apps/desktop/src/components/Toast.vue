<script setup lang="ts">
import { useUiStore } from "../stores/ui.js";

// 右上角轻提示:深色圆角胶囊 + 信息图标 + 文案 + 关闭键,内容由 ui store 的 toast 驱动。
// 显隐与自动消失都在 store 里管(showToast / dismissToast),这里只负责渲染和进出场动画。
const ui = useUiStore();
</script>

<template>
  <!-- 固定在视口右上角 = 会话窗口右上角(侧栏在左、会话区在右、占满高度) -->
  <Transition name="toast">
    <div v-if="ui.toast" :key="ui.toast.id" class="toast">
      <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="11" x2="12" y2="16" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
      <span class="msg">{{ ui.toast.message }}</span>
      <button class="close" aria-label="关闭提示" @click="ui.dismissToast()">×</button>
    </div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 1100;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px 10px 14px;
  background: #2c2c2e;
  color: #f5f5f7;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  font-size: 14px;
}
.ic { width: 18px; height: 18px; color: #9ca3af; flex-shrink: 0; }
.msg { white-space: nowrap; }
.close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: 2px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #9ca3af;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.close:hover { background: #3a3a3c; color: #f5f5f7; }

/* 进出场:从右上角轻微滑入 + 淡入 */
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-8px); }
</style>
