<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";

// busy: 讨论进行中。此时按钮变成方块"打断"键;否则是"发送"键。
// ended: 会话已结束。输入框仍可打字,但回车/点发送会被拦截(emit blocked),不真的发出去。
// locked: 有崩溃残留的未完成轮待用户选择（继续/放弃）。此时输入框禁用、无法打字/发送/结束,
//         强制用户先在上方提示条二选一,避免绕过未完成轮直接发新消息触发异常路径。
// contextUsed: 当前会话的上下文用量估算（父组件按会话消息文本估），驱动圆环 + 80% 压缩触发;
//   不传时退回占位演示值,只为单独预览组件用。
const props = defineProps<{ busy: boolean; ended: boolean; locked?: boolean; contextUsed?: number }>();
const emit = defineEmits<{ send: [text: string]; interrupt: []; end: []; blocked: []; compact: [] }>();
const text = ref("");
// 输入框 DOM 引用:挂载时自动聚焦,父组件(切换/新建会话时)也能通过暴露的 focus() 主动聚焦。
const inputEl = ref<HTMLTextAreaElement | null>(null);
// 自动增高上限:超过后输入框内部滚动,避免长需求把聊天区挤没。
const MAX_INPUT_HEIGHT = 100;

// 聚焦输入框,让用户打开会话后直接打字、无需先点一下输入框。
function focus(): void {
  inputEl.value?.focus();
}

// 输入内容变化时按 scrollHeight 增高;CSS 的 min-height 负责空内容时的基础高度。
function resizeInput(): void {
  const el = inputEl.value;
  if (!el) {
    return;
  }
  el.style.height = "auto";
  const nextHeight = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT);
  el.style.height = `${nextHeight}px`;
}

onMounted(() => {
  focus();
  resizeInput();
});
// 文本变化(包括发送后清空)等 DOM 更新完再重算高度。
watch(text, () => {
  nextTick(() => resizeInput());
});
defineExpose({ focus });

// ── 上下文用量横线 ────────────────────────────────────────────────
// 横线显示「当前上下文用量 / 上限」的比例;上限固定 256k(按 1024 换算),
// 当前值暂用占位常量(后续接真实 token 计数时只需替换 used 这一个来源)。
const MAX_CONTEXT = 256 * 1024;       // 256k 上限(1k = 1024)
const PLACEHOLDER_USED = 52122;       // 占位:≈50.9k,仅在父组件没传 contextUsed 时（单独预览）用
// 当前用量:优先用父组件传的真实估算,否则退回占位值。
const used = computed(() => props.contextUsed ?? PLACEHOLDER_USED);

// 用量占比,夹到 [0, 1],避免超额时进度条溢出。
const ratio = computed(() => {
  const raw = used.value / MAX_CONTEXT;
  if (raw < 0) {
    return 0;
  }
  if (raw > 1) {
    return 1;
  }
  return raw;
});
const percent = computed(() => Math.round(ratio.value * 100));
// 形如 "50.9k";上限是整数 k,直接拼。
const usedLabel = computed(() => {
  const k = used.value / 1024;
  return `${k.toFixed(1)}k`;
});
const maxLabel = `${MAX_CONTEXT / 1024}k`;

// 点击上下文用量条展开卡片，点击遮罩或按 Esc 收起。
const showMeter = ref(false);
function toggleMeter(): void {
  showMeter.value = !showMeter.value;
}
function onWindowKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && showMeter.value) {
    showMeter.value = false;
  }
}
onMounted(() => window.addEventListener("keydown", onWindowKey));
onUnmounted(() => window.removeEventListener("keydown", onWindowKey));

// 手动压缩:用户在用量卡里点「压缩」按钮 → 通知父组件去调 chat.compact。
// 不做任何阈值判断,按下即压;点完顺手关掉卡片。
function onCompactClick(): void {
  emit("compact");
  showMeter.value = false;
}

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
    <!-- 统一输入坞:输入框 + 按钮包进一张圆角卡,聚焦时整卡亮起暖色光环 -->
    <div class="composer-shell" :class="{ 'is-locked': locked }">
      <textarea
        ref="inputEl"
        v-model="text"
        rows="1"
        :disabled="locked"
        :placeholder="locked ? '请先在上方选择「继续」或「放弃」未完成的上一轮' : '输入会议需求…'"
        @input="resizeInput"
        @keydown="onKeydown"
      ></textarea>
      <!-- 上下文用量条悬在输入框右上方。 -->
      <button
        type="button"
        class="context-meter"
        :aria-expanded="showMeter"
        :title="`上下文用量 ${usedLabel} / ${maxLabel} (${percent}%)`"
        :aria-label="`上下文用量 ${usedLabel} / ${maxLabel} (${percent}%)`"
        @click="toggleMeter"
      >
        <span class="context-track">
          <span class="context-fill" :style="{ width: percent + '%' }"></span>
        </span>
      </button>
      <div class="actions">
        <div class="action-buttons">
          <button
            class="end"
            :disabled="busy || ended || locked"
            :title="ended ? '会议已结束' : '结束会议（仅空闲时可用）'"
            @click="emit('end')"
          >
            结束
          </button>
          <button
            :class="busy ? 'stop' : 'send'"
            :disabled="locked"
            :title="busy ? '打断当前讨论' : '发送'"
            @click="onButtonClick"
          >
            <span v-if="busy" class="square" aria-label="打断"></span>
            <span v-else>发送</span>
          </button>
        </div>
      </div>
      <div v-if="showMeter" class="meter-backdrop" @click="showMeter = false"></div>
      <div v-if="showMeter" class="meter-popover popup-popover">
        <div class="meter-row">
          <div class="meter-info">
            <span class="meter-label">Context window</span>
            <span class="meter-value">{{ usedLabel }} / {{ maxLabel }} ({{ percent }}%)</span>
          </div>
          <!-- 右侧手动压缩按钮:按下即压,不做阈值判断 -->
          <button type="button" class="compact-btn" title="压缩上下文" @click="onCompactClick">压缩</button>
        </div>
        <div class="meter-bar">
          <div class="meter-bar-fill" :style="{ width: percent + '%' }"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* composer 作用域内的光环 token(紫色),与全局 indigo 强调色同调 */
.composer {
  /* 与上方滚动区同色、且不画上边框:输入坞所在区与聊天区连成一整片同色背景,
     既没有分隔线、也没有「白板/暗带」色差,输入卡直接浮在聊天背景之上 */
  padding: 15px 16px 12px;
  background: var(--bg-chat);
  --glow: 124, 58, 237;            /* 紫色 rgb */
}

/* 输入框与操作按钮并排，多行输入时按钮保持在右下角。 */
.composer-shell {
  position: relative;            /* 供上下文横线与用量卡定位 */
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 12px 5px 14px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(0, 0, 0, 0.05)),
    var(--bg-elevated);
  box-shadow: var(--shadow-card);
  transition: border-color 0.2s ease, box-shadow 0.25s ease, background 0.2s ease;
}
/* 焦点落在坞内任意元素:点亮暖色光环(描边 + 内圈 + 外散光 + 落地阴影) */
.composer-shell:focus-within {
  border-color: rgba(var(--glow), 0.7);
  background:
    linear-gradient(180deg, rgba(var(--glow), 0.07), rgba(0, 0, 0, 0.05)),
    var(--bg-elevated);
  box-shadow:
    0 0 0 1px rgba(var(--glow), 0.5),
    0 0 24px -2px rgba(var(--glow), 0.45),
    0 10px 28px -10px rgba(0, 0, 0, 0.5);
}
/* 锁定态(有未完成轮待选择):整卡置灰、禁止交互 */
.composer-shell.is-locked { opacity: 0.6; }
.composer-shell.is-locked:focus-within {
  border-color: var(--border);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(0, 0, 0, 0.05)),
    var(--bg-elevated);
  box-shadow: var(--shadow-card);
}

/* 输入框:默认只占一行,随内容增多自动长高,超过上限后内部滚动 */
textarea {
  flex: 1;
  min-width: 0;
  min-height: 18px;
  max-height: 100px;
  padding: 0 4px;
  resize: none;
  overflow-y: auto;
  border: none;
  background: transparent;
  font-size: 14px;
  line-height: 18px;
  font-family: inherit;
  color: var(--text-main);
  outline: none;
}
textarea::placeholder { color: var(--text-dim); }
textarea:disabled { cursor: not-allowed; }

/* 结束和发送按钮靠右下。 */
.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  align-self: flex-end;
  gap: 8px;
}
.action-buttons { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* 发送 / 结束按钮:固定 34px 高,不再随输入框拉成长条 */
.action-buttons button {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 34px;
  min-width: 60px;
  padding: 0 14px;
  border: none;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.2s ease, filter 0.15s ease;
}
/* 发送:紫色主按钮,白色文字,悬浮微浮 + 紫光加深 */
.action-buttons button.send {
  color: #fff;
  background: linear-gradient(180deg, rgba(var(--glow), 0.98), rgba(var(--glow), 0.8));
  box-shadow: 0 2px 10px -3px rgba(var(--glow), 0.55);
}
.action-buttons button.send:not(:disabled):hover { transform: translateY(-1px); filter: brightness(1.06); box-shadow: 0 5px 16px -4px rgba(var(--glow), 0.6); }
.action-buttons button.send:not(:disabled):active { transform: translateY(0); box-shadow: 0 2px 10px -3px rgba(var(--glow), 0.55); }
/* 打断态:红色方块按钮 */
.action-buttons button.stop {
  color: #fff;
  background: #dc2626;
  box-shadow: 0 2px 10px -3px rgba(220, 38, 38, 0.55);
}
.action-buttons button.stop:not(:disabled):hover { transform: translateY(-1px); filter: brightness(1.06); }
.square { width: 13px; height: 13px; background: #fff; border-radius: 3px; }
/* 结束:安静的幽灵按钮,不抢主按钮的视觉权重 */
.action-buttons button.end {
  min-width: 56px;
  color: var(--text-dim);
  background: transparent;
  border: 1px solid var(--border);
  box-shadow: none;
}
.action-buttons button.end:not(:disabled):hover { color: var(--text-main); border-color: var(--text-dim); background: rgba(127, 127, 127, 0.08); transform: none; filter: none; }
/* 禁用态(锁定/已结束等):统一置灰、禁止点击 */
.action-buttons button:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
.action-buttons button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ── 上下文用量横线 + 悬浮卡 ──────────────────────────────── */
/* 用量条在输入框外侧，保留 10px 高的点击区域。 */
.context-meter {
  position: absolute;
  bottom: calc(100% + 4px);
  right: 14px;
  display: flex;
  align-items: center;
  width: 92px;
  height: 10px;
  padding: 0 2px;
  border: none;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
}
.context-meter[aria-expanded="true"] { z-index: 11; }
.context-meter:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.context-track {
  display: block;
  width: 100%;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.22);
  transition: background 0.15s ease;
}
.context-meter:hover .context-track { background: rgba(127, 127, 127, 0.34); }
.context-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(var(--glow), 0.7), rgba(var(--glow), 1));
  transition: width 0.3s ease;
}

/* 遮罩:铺满视口接住点击,点一下关卡;透明、不挡视觉 */
.meter-backdrop { position: fixed; inset: 0; z-index: 10; }
/* 悬浮卡:在输入坞上方展开,右缘对齐右上角的横线,窄窗口也不会越界 */
.meter-popover {
  --popup-origin: bottom right;
  position: absolute;
  right: 0;
  bottom: calc(100% + 20px);
  z-index: 20;
  width: min(100%, 360px);
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid rgba(var(--glow), 0.35);
  box-shadow:
    var(--shadow-card),
    0 8px 24px -10px rgba(0, 0, 0, 0.5);
}
.meter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
/* 左侧信息组:标题与数值同一行 */
.meter-info { display: flex; flex-direction: row; align-items: baseline; gap: 8px; }
.meter-label { font-size: 12px; color: var(--text-dim); }
.meter-value {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-main);
  font-variant-numeric: tabular-nums;
}
/* 手动压缩按钮:小号紫色胶囊,和圆环一起待在工具栏上方的用量卡里 */
.compact-btn {
  flex-shrink: 0;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(var(--glow), 0.98), rgba(var(--glow), 0.8));
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.15s ease;
}
.compact-btn:hover { transform: translateY(-1px); filter: brightness(1.06); }
.meter-bar {
  height: 6px;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.25);
  overflow: hidden;
}
.meter-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(var(--glow), 0.7), rgba(var(--glow), 1));
  transition: width 0.3s ease;
}
</style>
