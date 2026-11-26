<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../utils/markdown.js";
import MeetingDialog from "./MeetingDialog.vue";

const props = defineProps<{ filename: string; markdown: string }>();
const emit = defineEmits<{ close: [] }>();

const preview = computed(() => {
  const timeLine = props.markdown.match(/^会议时间[：:][ \t]*([^\r\n]+)(?:\r?\n|$)/);
  const time = timeLine?.[1]?.trim();
  let body = timeLine ? props.markdown.slice(timeLine[0].length) : props.markdown;

  // 导出的 Markdown 自带总标题，模型也可能再写一次。预览保留弹窗顶部的标题。
  const repeatTitle = /^(?:[ \t]*\r?\n)* {0,3}#[ \t]+会议纪要[ \t]*(?:\r?\n|$)/;
  while (repeatTitle.test(body)) {
    body = body.replace(repeatTitle, "");
  }

  return { time, html: renderMarkdown(body) };
});

function downloadMinutes(): void {
  const file = new Blob([props.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = props.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <MeetingDialog class="minutes-dialog" title="会议纪要" @close="emit('close')">
    <template #header-details>
      <dl v-if="preview.time" class="minutes-time">
        <dt>会议时间</dt>
        <dd>{{ preview.time }}</dd>
      </dl>
    </template>
    <article class="minutes-content" tabindex="0" aria-label="纪要正文" v-html="preview.html"></article>
    <template #footer>
      <button type="button" class="download" @click="downloadMinutes">下载 Markdown</button>
    </template>
  </MeetingDialog>
</template>

<style scoped>
.minutes-dialog {
  --meeting-dialog-width: 700px;
  --meeting-dialog-inset: clamp(18px, 5vw, 36px);
  --meeting-dialog-title-size: 21px;
}
.minutes-time {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 3px 10px;
  margin: 5px 0 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.6;
}
.minutes-time dt { font-weight: 600; }
.minutes-time dd {
  min-width: 0;
  margin: 0;
  font-variant-numeric: tabular-nums;
  text-wrap: balance;
}
.minutes-content {
  margin: 4px 0 8px;
  font-size: 14px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.minutes-content:focus-visible, .download:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.minutes-content :deep(> :first-child) { margin-top: 0; }
.minutes-content :deep(> :last-child) { margin-bottom: 0; }
.minutes-content :deep(h1), .minutes-content :deep(h2) {
  margin: 26px 0 10px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--border);
  font-size: 17px;
  font-weight: 650;
  line-height: 1.5;
}
.minutes-content :deep(h3), .minutes-content :deep(h4), .minutes-content :deep(h5), .minutes-content :deep(h6) {
  margin: 17px 0 6px;
  font-size: 14px;
  font-weight: 650;
}
.minutes-content :deep(p), .minutes-content :deep(ul), .minutes-content :deep(ol) { margin: 0 0 12px; }
.minutes-content :deep(ul), .minutes-content :deep(ol) { padding-inline-start: 1.5em; }
.minutes-content :deep(li + li) { margin-top: 4px; }
.minutes-content :deep(li > ul), .minutes-content :deep(li > ol) { margin: 4px 0 0; }
.minutes-content :deep(li::marker) { color: var(--text-dim); }
.minutes-content :deep(a) { color: inherit; text-underline-offset: 3px; }
.minutes-content :deep(img) { max-width: 100%; height: auto; }
.minutes-content :deep(hr) { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
.minutes-content :deep(blockquote) {
  margin: 12px 0;
  padding: 4px 14px;
  border-inline-start: 3px solid var(--border);
  color: var(--text-dim);
}
.minutes-content :deep(blockquote > :last-child) { margin-bottom: 0; }
.minutes-content :deep(code), .minutes-content :deep(pre) { background: var(--bg-elevated); border-radius: 5px; }
.minutes-content :deep(code) { padding: 2px 4px; }
.minutes-content :deep(pre) { overflow: auto; padding: 10px 12px; }
.minutes-content :deep(pre code) { padding: 0; }
.minutes-content :deep(table) {
  display: block;
  overflow-x: auto;
  margin: 12px 0;
  border-collapse: collapse;
  font-size: 13px;
}
.minutes-content :deep(th), .minutes-content :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--border);
  text-align: start;
}
.minutes-content :deep(th) { background: var(--bg-elevated); }
.download {
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-elevated);
  color: var(--text-main);
  padding: 8px 12px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
}
.download:hover { border-color: var(--accent); }
</style>
