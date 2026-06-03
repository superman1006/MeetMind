<script setup lang="ts">
// 轻量悬浮提示:把触发元素放进默认插槽,鼠标悬浮时在其旁边显示一个深色气泡。
// 纯 CSS(:hover)实现,无 JS 定时器;目前用于会话列表头部那几个图标按钮。
withDefaults(
  defineProps<{
    label: string;
    placement?: "top" | "bottom" | "right";
  }>(),
  {
    placement: "bottom",
  },
);
</script>

<template>
  <span class="tip-wrap">
    <slot />
    <span class="tip" :class="placement">{{ label }}</span>
  </span>
</template>

<style scoped>
.tip-wrap { position: relative; display: inline-flex; }
/* 气泡:默认隐藏,悬浮父级时淡入。深色底白字,仿设计稿。 */
.tip {
  position: absolute;
  white-space: nowrap;
  background: #2c2c2e;
  color: #f5f5f7;
  font-size: 12px;
  line-height: 1;
  padding: 6px 9px;
  border-radius: 7px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.12s ease, visibility 0.12s ease;
  transition-delay: 0.05s;
  z-index: 1200;
}
/* 下方(默认):气泡在触发元素正下方,留 6px 间隙 */
.tip.bottom { top: calc(100% + 6px); left: 50%; transform: translateX(-50%); }
/* 上方 */
.tip.top { bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); }
/* 右侧:收缩态窄轨里用,避免气泡被屏幕左缘裁切 */
.tip.right { left: calc(100% + 6px); top: 50%; transform: translateY(-50%); }
.tip-wrap:hover .tip { opacity: 1; visibility: visible; }
</style>
