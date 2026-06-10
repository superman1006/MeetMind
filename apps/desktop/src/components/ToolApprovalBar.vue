<script setup lang="ts">
// 工具风险审批条:某个 risk>low 的工具执行前,后端挂起等用户拍板,这里浮在输入框上方。
// 左侧 = 工具名 + risk 徽章(medium 橙 / high 红,只显示英文);右侧 = 同意 / 拒绝两个按钮。
// 自己不发 RPC,只把决策 emit 给上层(ChatWindow),和 Composer 的职责划分一致。
defineProps<{ tool: string; risk: string }>();
const emit = defineEmits<{ decide: [approved: boolean] }>();
</script>

<template>
  <div class="approval">
    <div class="info">
      <span class="hint">该工具需要确认</span>
      <span class="tool">{{ tool }}</span>
      <span class="risk" :class="risk">{{ risk }}</span>
    </div>
    <div class="actions">
      <button class="agree" @click="emit('decide', true)">同意</button>
      <button class="reject" @click="emit('decide', false)">拒绝</button>
    </div>
  </div>
</template>

<style scoped>
/* 悬浮在 Composer 上方的圆角卡片:四角全圆 + 紫色光环(描边 + 内圈 + 外散光,
   和输入坞聚焦时同款)+ 抬升阴影,四周留 margin 与输入框/侧边拉开间隔,
   像一块浮起来的提示牌。宽度收到容器的 2/3,左对齐,避免中间大段留白。 */
.approval {
  --glow: 124, 58, 237;            /* 紫色 rgb,与 Composer 聚焦光环同色 */
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 66.67%;
  box-sizing: border-box;
  margin: 12px auto;
  padding: 12px 16px;
  background: var(--bg-elevated);
  border: 1px solid rgba(var(--glow), 0.7);
  border-radius: 14px;
  box-shadow:
    0 0 0 1px rgba(var(--glow), 0.5),
    0 0 24px -2px rgba(var(--glow), 0.45),
    0 10px 28px -10px rgba(0, 0, 0, 0.5);
}
.info { display: flex; align-items: center; gap: 8px; min-width: 0; }
.hint { font-size: 12px; color: var(--text-dim); flex-shrink: 0; }
.tool { font-size: 14px; font-weight: 600; color: var(--text-main); font-family: ui-monospace, "SF Mono", Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* risk 徽章:medium 橙、high 红;只显示英文,大小写按后端原样。 */
.risk { flex-shrink: 0; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; color: #fff; }
.risk.medium { background: #f59e0b; }
.risk.high { background: #dc2626; }
.actions { display: flex; gap: 8px; flex-shrink: 0; }
button { min-width: 56px; padding: 6px 16px; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; transition: transform 0.15s ease, filter 0.15s ease; }
button:hover { transform: translateY(-1px); filter: brightness(1.05); }
button.agree { background: var(--accent); color: #fff; }
button.reject { background: #6b7280; color: #fff; }
</style>
