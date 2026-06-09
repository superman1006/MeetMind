<script setup lang="ts">
import { ref, onMounted } from "vue";

// busy: 讨论进行中。此时按钮变成方块"打断"键;否则是"发送"键。
// ended: 会话已结束。输入框仍可打字,但回车/点发送会被拦截(emit blocked),不真的发出去。
// locked: 有崩溃残留的未完成轮待用户选择（继续/放弃）。此时输入框禁用、无法打字/发送/结束,
//         强制用户先在上方提示条二选一,避免绕过未完成轮直接发新消息触发异常路径。
const props = defineProps<{ busy: boolean; ended: boolean; locked?: boolean }>();
const emit = defineEmits<{ send: [text: string]; interrupt: []; end: []; blocked: [] }>();
const text = ref("");
// 输入框 DOM 引用:挂载时自动聚焦,父组件(切换/新建会话时)也能通过暴露的 focus() 主动聚焦。
const inputEl = ref<HTMLTextAreaElement | null>(null);

// 聚焦输入框,让用户打开会话后直接打字、无需先点一下输入框。
function focus(): void {
  inputEl.value?.focus();
}

onMounted(focus);
defineExpose({ focus });

function submit(): void {
  const value = text.value.trim();
  if (!value || props.busy || props.locked) {
    return;
  }
  emit("send", value);
  text.value = "";
}

// 按钮点击:locked 时按钮已禁用、不响应;busy 时打断,已结束则拦截弹窗,否则发送。
function onButtonClick(): void {
  if (props.locked) {
    return;
  }
  if (props.busy) {
    emit("interrupt");
  } else if (props.ended) {
    emit("blocked");
  } else {
    submit();
  }
}

function onKeydown(e: KeyboardEvent): void {
  // 有未完成轮待选择时禁止一切输入/发送,等用户先在提示条二选一。
  if (props.locked) {
    e.preventDefault();
    return;
  }
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
      ref="inputEl"
      v-model="text"
      :disabled="locked"
      :placeholder="locked ? '请先在上方选择「继续」或「放弃」未完成的上一轮' : '输入项目需求… (Enter 发送, Shift+Enter 换行)'"
      @keydown="onKeydown"
    ></textarea>
    <button
      :class="{ stop: busy }"
      :disabled="locked"
      :title="busy ? '打断当前讨论' : '发送'"
      @click="onButtonClick"
    >
      <span v-if="busy" class="square" aria-label="打断"></span>
      <span v-else>发送</span>
    </button>
    <button
      class="end"
      :disabled="busy || ended || locked"
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
/* 锁定态(有未完成轮待选择):输入框置灰、禁止交互 */
textarea:disabled { opacity: 0.6; cursor: not-allowed; background: var(--bg-elevated); }
/* 操作按钮:实心强调色,悬浮微微上浮 + 阴影加深 */
button { display: flex; align-items: center; justify-content: center; min-width: 64px; padding: 0 20px; background: var(--accent); color: #fff; border: none; border-radius: 12px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: var(--shadow-card); transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease; }
button:not(:disabled):hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); filter: brightness(1.05); }
button:not(:disabled):active { transform: translateY(0); box-shadow: var(--shadow-card); }
/* 打断态:红色方块按钮 */
button.stop { background: #dc2626; }
.square { width: 14px; height: 14px; background: #fff; border-radius: 3px; }
/* 禁用态(锁定/已结束等):统一置灰、禁止点击 */
button:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
/* 结束会议按钮:灰色,仅空闲可用 */
button.end { background: #6b7280; min-width: 56px; }
</style>
