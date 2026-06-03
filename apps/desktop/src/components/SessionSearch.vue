<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import type { SessionMeta } from "../stores/sessions.js";

// 会话标题搜索模态:在已加载的会话标题里即时过滤(纯前端,无后端)。
// 点结果 → emit('select', id) 由父组件跳转;Esc / 点遮罩 / 点 X 关闭。
const props = defineProps<{ sessions: SessionMeta[] }>();
const emit = defineEmits<{ select: [id: string]; close: [] }>();

const query = ref("");
const input = ref<HTMLInputElement | null>(null);

// 一行搜索结果:标题按首个命中位置切成 before/match/after,便于把命中段高亮。
interface ResultRow {
  id: string;
  before: string;
  match: string;
  after: string;
  time: string;
}

function two(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// 把 DB 的 created_at 格式化成 "2026-6-2 18:23";缺失/非法时返回空串(该行不显示时间)。
function formatTime(createdAt?: string): string {
  if (!createdAt) {
    return "";
  }
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const date = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return `${date} ${time}`;
}

// 过滤 + 切分高亮段,全程显式 for,不写链式管道(house style)。
const results = computed<ResultRow[]>(() => {
  const q = query.value.trim().toLowerCase();
  const rows: ResultRow[] = [];
  for (const s of props.sessions) {
    const title = s.title ?? "";
    // query 为空:列全部(当快速切换器用);非空:只留标题命中的
    let matchAt = -1;
    if (q) {
      matchAt = title.toLowerCase().indexOf(q);
      if (matchAt === -1) {
        continue;
      }
    }
    // 按首个命中位置把标题切成 before/match/after(空 query 时整段当 before、不高亮)
    let before = title;
    let match = "";
    let after = "";
    if (matchAt >= 0) {
      before = title.slice(0, matchAt);
      match = title.slice(matchAt, matchAt + q.length);
      after = title.slice(matchAt + q.length);
    }
    rows.push({ id: s.id, before, match, after, time: formatTime(s.created_at) });
  }
  return rows;
});

// 回车选中第一个结果(IME 合成中按回车是上屏候选词,不处理)。
function onInputKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) {
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const list = results.value;
    if (list.length > 0) {
      emit("select", list[0].id);
    }
  }
}

// Esc 关闭(挂 window,焦点在哪都能触发)。
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    emit("close");
  }
}

onMounted(() => {
  window.addEventListener("keydown", onWindowKeydown);
  input.value?.focus();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onWindowKeydown));
</script>

<template>
  <!-- 点遮罩空白处关闭;点面板本体不冒泡 -->
  <div class="overlay" @click="emit('close')">
    <div class="panel" @click.stop>
      <div class="search-box">
        <svg class="m-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref="input"
          v-model="query"
          class="search-input"
          placeholder="搜索会话标题…"
          @keydown="onInputKeydown"
        />
        <button class="close" title="关闭" @click="emit('close')">✕</button>
      </div>
      <ul v-if="results.length > 0" class="results">
        <li v-for="r in results" :key="r.id" class="result" @click="emit('select', r.id)">
          <span class="r-title"><span>{{ r.before }}</span><mark v-if="r.match">{{ r.match }}</mark><span>{{ r.after }}</span></span>
          <span v-if="r.time" class="r-time">{{ r.time }}</span>
        </li>
      </ul>
      <div v-else class="empty">没有匹配的会话</div>
    </div>
  </div>
</template>

<style scoped>
/* 复用项目里其它模态的深色风格(ConfirmDialog/MeetingEndDialog),靠上对齐仿设计稿 */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  z-index: 1000;
}
.panel { width: min(640px, calc(100vw - 48px)); }
/* 顶部搜索条 */
.search-box {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #3a3a3c;
  border-radius: 14px;
  padding: 14px 18px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}
.m-icon { width: 20px; height: 20px; color: #9ca3af; flex-shrink: 0; }
.search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: #f5f5f7;
  font-size: 16px;
  font-family: inherit;
}
.search-input::placeholder { color: #8e8e93; }
.close {
  background: transparent;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 4px;
  border-radius: 6px;
  flex-shrink: 0;
}
.close:hover { color: #f5f5f7; }
/* 结果列表:独立一块深色面板,挂在搜索条下方 */
.results {
  list-style: none;
  margin: 8px 0 0;
  padding: 6px;
  background: #2c2c2e;
  border-radius: 14px;
  max-height: 50vh;
  overflow-y: auto;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}
.result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  cursor: pointer;
}
.result:hover { background: #3a3a3c; }
.r-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f5f5f7; font-size: 15px; }
.r-title mark { background: transparent; color: #fff; font-weight: 700; }
.r-time { color: #8e8e93; font-size: 12px; flex-shrink: 0; }
.empty {
  margin-top: 8px;
  padding: 24px;
  text-align: center;
  color: #8e8e93;
  background: #2c2c2e;
  border-radius: 14px;
  font-size: 14px;
}
</style>
