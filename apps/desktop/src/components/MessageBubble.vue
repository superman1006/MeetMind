<script setup lang="ts">
import { computed, ref } from "vue";
import type { Bubble } from "../stores/chat.js";
import { agentColor } from "../theme/agentColors.js";
import { useUiStore } from "../stores/ui.js";
import { renderMarkdown } from "../utils/markdown.js";
import TypingDots from "./TypingDots.vue";

const props = defineProps<{ bubble: Bubble }>();
const ui = useUiStore();
// 气泡配色随主题走:浅色用浅底深字,深色用深底亮字。切主题时 ui.theme 变 → 这里自动重算。
const color = computed(() => agentColor(props.bubble.agent_name, ui.theme));

// agent 回复带 Markdown 语法(## 标题、列表、代码块等),渲染成已净化的 HTML 再用 v-html 显示。
// 用户气泡保持纯文本(不把用户输入当 Markdown 解析)。流式输出时 text 每变一次就重渲染一次。
const renderedHtml = computed(() => renderMarkdown(props.bubble.text));

// agent 气泡已建但还没吐出任何 content(Phase 1 工具循环中)→ 显示流动点,表示思考中
const thinking = computed(() => !props.bubble.isUser && props.bubble.text.length === 0);

// 当前展开的工具调用下标(-1 = 没展开)。点按钮切换:点同一个收起,点别的切换。
const openIndex = ref(-1);
function toggle(i: number): void {
  openIndex.value = openIndex.value === i ? -1 : i;
}
// 当前展开的那次调用(下标越界/未展开则为 null)
const openCall = computed(() => {
  const i = openIndex.value;
  if (i < 0 || i >= props.bubble.toolCalls.length) {
    return null;
  }
  return props.bubble.toolCalls[i];
});
// 把入参对象转成一行 JSON 供展示
function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

// 把 epoch 毫秒格式化成 "2026-6-2 18:23"(年-月-日 时:分,24 小时制,补零到分)。
function two(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
const sentAt = computed(() => {
  const d = new Date(props.bubble.createdAt);
  const date = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return `${date} ${time}`;
});

// 复制气泡正文:点右上角小按钮把当前气泡文字写进剪贴板,成功后短暂显示 ✓。
const copied = ref(false);
async function copyText(): Promise<void> {
  const content = props.bubble.text;
  if (content.length === 0) {
    return;
  }
  try {
    await navigator.clipboard.writeText(content);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1200);
  } catch {
    // 剪贴板不可用(无 https / 权限被拒)时静默失败,不打断聊天。
  }
}

// 复制展开的那次工具调用信息(名字 + 入参 + 返回结果),成功后短暂显示 ✓。
const toolCopied = ref(false);
async function copyToolCall(): Promise<void> {
  const call = openCall.value;
  if (call === null) {
    return;
  }
  const lines = [`${call.name} ${formatArgs(call.args)}`, "", call.result];
  const content = lines.join("\n");
  try {
    await navigator.clipboard.writeText(content);
    toolCopied.value = true;
    setTimeout(() => {
      toolCopied.value = false;
    }, 1200);
  } catch {
    // 同上:剪贴板不可用时静默失败。
  }
}
</script>

<template>
  <div class="row" :class="{ mine: bubble.isUser }">
    <div class="bubble" :style="{ background: color.bg, color: color.fg }">
      <div class="head">
        <span class="role">{{ bubble.role || color.label }}</span>
      </div>

      <!-- 右上角复制按钮:平时半透明很淡,hover 气泡时浮现,点一下复制本气泡正文 -->
      <button
        v-if="!thinking"
        type="button"
        class="copy-btn"
        :title="copied ? '已复制' : '复制本条内容'"
        @click="copyText"
      >{{ copied ? "✓" : "⧉" }}</button>

      <!-- 工具调用:每次调用一个按钮,点击在正文下方展开该次调用的结果 -->
      <div v-if="bubble.toolCalls.length" class="tools">
        <button
          v-for="(call, i) in bubble.toolCalls"
          :key="i"
          type="button"
          class="tool-btn"
          :class="{ active: openIndex === i }"
          :title="`查看 ${call.name} 的调用结果`"
          @click="toggle(i)"
        >
          <svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.3 2.3a1.5 1.5 0 0 1-2.1-2.1z" />
          </svg>
          <span class="tool-name">{{ call.name }}</span>
        </button>
      </div>

      <TypingDots v-if="thinking" />
      <!-- 用户气泡纯文本;agent 气泡按 Markdown 渲染(已净化) -->
      <div v-else-if="bubble.isUser" class="text">{{ bubble.text }}</div>
      <div v-else class="text markdown" v-html="renderedHtml"></div>

      <!-- 工具调用结果面板:点某个按钮后在正文下方展开,显示入参 + 返回结果 -->
      <div v-if="openCall" class="tool-panel">
        <!-- 工具信息面板右上角也放一个复制按钮:复制本次调用的名字 + 入参 + 返回结果 -->
        <button
          type="button"
          class="copy-btn tool-copy-btn"
          :title="toolCopied ? '已复制' : '复制工具调用信息'"
          @click="copyToolCall"
        >{{ toolCopied ? "✓" : "⧉" }}</button>
        <div class="tool-panel-head">
          <span class="tool-panel-name">{{ openCall.name }}</span>
          <span class="tool-panel-args">{{ formatArgs(openCall.args) }}</span>
        </div>
        <pre class="tool-panel-result">{{ openCall.result }}</pre>
      </div>

      <!-- 消息发送时间:思考中(还没出内容)不显示,有内容后挂在气泡底部 -->
      <time v-if="!thinking" class="time">{{ sentAt }}</time>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; margin: 8px 0; }
.row.mine { justify-content: flex-end; }
.bubble { position: relative; max-width: 72%; padding: 10px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }

/* 复制按钮:小、淡、贴右上角。平时几乎隐形,hover 气泡时浮现,不抢正文注意力 */
.copy-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s;
}
.bubble:hover .copy-btn { opacity: 0.5; }
.copy-btn:hover { opacity: 1 !important; background: rgba(0, 0, 0, 0.12); }
:root[data-theme="dark"] .copy-btn:hover { background: rgba(255, 255, 255, 0.16); }
.head { display: flex; gap: 8px; align-items: center; font-size: 12px; opacity: 0.85; margin-bottom: 4px; }
.role { font-weight: 600; }
.text { font-size: 14px; line-height: 1.5; }

/* Markdown 正文:容器要回到 normal 空白处理,否则继承 .bubble 的 pre-wrap 会把
   markdown-it 标签间的换行渲染成多余空行。子元素用 :deep() 穿透 scoped 作用域
   (v-html 生成的节点不带 scoped 的 data 属性,普通选择器选不到)。 */
.markdown { white-space: normal; }
.markdown :deep(> *:first-child) { margin-top: 0; }
.markdown :deep(> *:last-child) { margin-bottom: 0; }
.markdown :deep(h1) { font-size: 18px; font-weight: 700; margin: 12px 0 6px; }
.markdown :deep(h2) { font-size: 16px; font-weight: 700; margin: 12px 0 6px; }
.markdown :deep(h3) { font-size: 15px; font-weight: 600; margin: 10px 0 5px; }
.markdown :deep(h4), .markdown :deep(h5), .markdown :deep(h6) { font-size: 14px; font-weight: 600; margin: 8px 0 4px; }
.markdown :deep(p) { margin: 6px 0; }
.markdown :deep(ul), .markdown :deep(ol) { margin: 6px 0; padding-left: 22px; }
.markdown :deep(li) { margin: 2px 0; }
.markdown :deep(a) { color: inherit; text-decoration: underline; }
.markdown :deep(strong) { font-weight: 700; }
.markdown :deep(em) { font-style: italic; }
.markdown :deep(blockquote) { margin: 6px 0; padding: 2px 10px; border-left: 3px solid currentColor; opacity: 0.85; }
.markdown :deep(hr) { border: none; border-top: 1px solid currentColor; opacity: 0.3; margin: 10px 0; }
.markdown :deep(table) { border-collapse: collapse; margin: 6px 0; }
.markdown :deep(th), .markdown :deep(td) { border: 1px solid currentColor; padding: 3px 8px; }
/* 行内代码:浅底药丸;深浅主题各给一层叠加,贴合气泡底色 */
.markdown :deep(code) { font-family: ui-monospace, monospace; font-size: 12.5px; background: rgba(0, 0, 0, 0.08); padding: 1px 5px; border-radius: 5px; }
.markdown :deep(pre) { margin: 6px 0; padding: 8px 10px; border-radius: 8px; background: rgba(0, 0, 0, 0.1); overflow-x: auto; }
/* 代码块里的 code 去掉行内药丸样式 */
.markdown :deep(pre code) { background: transparent; padding: 0; font-size: 12px; line-height: 1.45; }
:root[data-theme="dark"] .markdown :deep(code) { background: rgba(255, 255, 255, 0.14); }
:root[data-theme="dark"] .markdown :deep(pre) { background: rgba(255, 255, 255, 0.1); }

/* 工具按钮:一排小药丸,每个对应一次工具调用。
   软底填充 + 极淡描边,比硬描边(border: currentColor)更耐看、不抢正文 */
.tools { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  padding: 4px 10px 4px 7px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.05);
  color: inherit;
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.12s, background 0.12s, border-color 0.12s;
}
.tool-btn:hover { opacity: 1; background: rgba(0, 0, 0, 0.09); }
.tool-btn.active {
  background: rgba(0, 0, 0, 0.12);
  border-color: rgba(0, 0, 0, 0.16);
  opacity: 1;
  font-weight: 600;
}
/* 扳手图标:跟随文字色,略淡一点跟文字拉开层次 */
.tool-icon { width: 12px; height: 12px; flex-shrink: 0; opacity: 0.65; }
.tool-name { display: inline-block; }

/* 结果面板:浅色内嵌卡片,结果超长可滚动 */
.tool-panel {
  position: relative;
  margin-top: 8px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 8px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.4);
}
/* 面板里的复制按钮:贴面板右上角,给 head 留出右侧空位避免压到入参 */
.tool-copy-btn { top: 6px; right: 6px; }
.bubble:hover .tool-copy-btn { opacity: 0.5; }
.tool-panel-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-bottom: 6px; padding-right: 24px; }
.tool-panel-name { font-weight: 600; font-size: 12px; }
.tool-panel-args { font-family: ui-monospace, monospace; font-size: 11px; opacity: 0.7; word-break: break-all; }
.tool-panel-result {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, monospace;
  font-size: 11.5px;
  line-height: 1.45;
}

/* 深色主题:气泡改成深底亮字后,工具按钮/结果面板的黑白叠加层要反过来,
   否则浅色面板上的亮字读不清。:root 选中 <html data-theme>,面板在本组件内仍受作用域限定。 */
:root[data-theme="dark"] .tool-btn {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.08);
}
:root[data-theme="dark"] .tool-btn:hover { background: rgba(255, 255, 255, 0.13); }
:root[data-theme="dark"] .tool-btn.active {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.22);
}
:root[data-theme="dark"] .tool-panel {
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.07);
}

/* 发送时间:小号、半透明,右对齐挂在气泡底部 */
.time { display: block; margin-top: 4px; font-size: 10px; opacity: 0.6; text-align: right; }
</style>
