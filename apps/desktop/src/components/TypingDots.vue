<script setup lang="ts">
// 纯 CSS 三点流动动画:agent 思考中 / 加载中的指示器,复用于空气泡和尾部占位气泡。
</script>

<template>
  <span class="dots" aria-label="加载中">
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
  </span>
</template>

<style scoped>
.dots { display: inline-flex; gap: 4px; align-items: center; height: 18px; }
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.35;
  animation: dot-flow 1.2s infinite ease-in-out;
}
/* 三点错峰起跳,形成从左到右流动的效果 */
.dot:nth-child(2) { animation-delay: 0.2s; }
.dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes dot-flow {
  0%, 60%, 100% { opacity: 0.35; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-3px); }
}
</style>
