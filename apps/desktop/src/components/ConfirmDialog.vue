<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";

// 屏幕居中的确认弹窗,替代浏览器原生 confirm。
// 由父组件用 v-if 控制显隐;确认/取消通过事件回传。
withDefaults(
  defineProps<{
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean; // true 时确认键用红色(删除类操作)
  }>(),
  {
    confirmLabel: "确定",
    cancelLabel: "取消",
    danger: false,
  },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

// Esc 取消,提升可用性
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    emit("cancel");
  }
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <!-- 点遮罩空白处 = 取消;点对话框本体不冒泡 -->
  <div class="overlay" @click="emit('cancel')">
    <div class="dialog" @click.stop>
      <h2 class="title">{{ title }}</h2>
      <p class="message">{{ message }}</p>
      <div class="actions">
        <button class="btn cancel" @click="emit('cancel')">{{ cancelLabel }}</button>
        <button class="btn confirm" :class="{ danger }" @click="emit('confirm')">
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.dialog {
  width: min(440px, calc(100vw - 48px));
  background: #2c2c2e;
  color: #f5f5f7;
  border-radius: 16px;
  padding: 24px 24px 18px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}
.title { margin: 0 0 8px; font-size: 22px; font-weight: 700; }
.message { margin: 0 0 22px; font-size: 14px; line-height: 1.5; color: #c7c7cc; }
.actions { display: flex; justify-content: flex-end; gap: 10px; }
.btn {
  padding: 9px 18px;
  border: none;
  border-radius: 9px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.cancel { background: #48484a; color: #f5f5f7; }
.cancel:hover { background: #545456; }
.confirm { background: #4f46e5; color: #fff; }
.confirm:hover { background: #4338ca; }
.confirm.danger { background: #e0483d; }
.confirm.danger:hover { background: #c93a30; }
</style>
