<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { rpc } from "../api/rpcClient.js";
import { useChatStore } from "../stores/chat.js";

interface PlanRound {
  id: string;
  requirement: string;
  status: "running" | "completed" | "interrupted" | "failed";
  mode: "direct" | "task" | "everyone" | null;
  plan: { title: string; steps: Array<{ agentName: string; displayName?: string; instruction: string }> } | null;
  completed_steps: number;
}

type PlannedRound = PlanRound & { plan: NonNullable<PlanRound["plan"]> };

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ close: [] }>();
const chat = useChatStore();
const rounds = ref<PlanRound[]>([]);
const error = ref("");
const loading = ref(true);
const latest = computed(() => rounds.value[0]);
const plannedRounds = computed(() => rounds.value.filter((round): round is PlannedRound => round.plan !== null));
const statusLabels = { running: "进行中", completed: "已完成", interrupted: "已中断", failed: "执行失败" };

// 切换会议或收到计划更新时，从服务端读取该会议的轮次与已完成步数。
watch(() => [props.sessionId, chat.planVersionBySession[props.sessionId]], async (_, before, onCleanup) => {
  let active = true;
  // 让已失效的请求结果退出，避免慢响应覆盖当前选中的会议。
  onCleanup(() => { active = false; });
  if (!before || before[0] !== props.sessionId) {
    rounds.value = [];
    loading.value = true;
  }
  try {
    const response = await rpc<PlanRound[]>("session.plans", { sessionId: props.sessionId });
    if (!active) return;
    rounds.value = response;
    error.value = "";
  } catch (failure) {
    if (active) error.value = String(failure);
  } finally {
    if (active) loading.value = false;
  }
}, { immediate: true });
</script>

<template>
  <aside class="plan popup-popover" aria-label="任务计划">
    <header>
      <h2>任务计划</h2>
      <button type="button" aria-label="关闭任务计划" @click="emit('close')">×</button>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loading" role="status">正在读取任务计划…</p>
    <p v-else-if="!latest">主持人发送需求后，任务计划会显示在这里。</p>
    <template v-else>
      <ul v-if="plannedRounds.length" class="tasks" role="list">
        <li v-for="round in plannedRounds" :key="round.id">
          <details>
            <summary class="task-summary">
              <strong>{{ round.plan.title }}</strong>
              <span class="task-meta">
                <span>{{ statusLabels[round.status] }}</span>
                <span>{{ round.completed_steps }}/{{ round.plan.steps.length }}</span>
              </span>
            </summary>
            <div class="subtask-group">
              <p v-if="round.requirement !== round.plan.title" class="requirement">{{ round.requirement }}</p>
              <ol class="subtasks" role="list">
                <li v-for="(step, index) in round.plan.steps" :key="index" class="subtask">
                  <span
                    class="step-marker"
                    :class="{ complete: index < round.completed_steps }"
                    role="img"
                    :aria-label="index < round.completed_steps ? '已完成' : '未完成'"
                  ><span v-if="index < round.completed_steps" aria-hidden="true">✓</span></span>
                  <div class="subtask-content">
                    <strong class="subtask-name">{{ step.displayName || step.agentName }}</strong>
                    <p class="subtask-message">{{ step.instruction }}</p>
                  </div>
                </li>
              </ol>
            </div>
          </details>
        </li>
      </ul>
      <template v-if="!latest.plan">
        <p v-if="latest.mode === 'direct'">本轮由主持人的数字人直接回复。</p>
        <p v-else-if="latest.status === 'running'" role="status">正在规划本轮任务…</p>
        <p v-else>本轮未生成任务计划。</p>
        <p class="status">{{ statusLabels[latest.status] }}</p>
      </template>
    </template>
  </aside>
</template>

<style scoped>
.plan {
  --popup-origin: top right;
  --popup-offset-y: -5px;
  --step-complete: #15803d;
  position: absolute;
  top: calc(100% + 5px);
  right: 16px;
  width: min(360px, calc(100% - 32px));
  max-height: min(55vh, 360px);
  overflow-y: auto;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-chat);
  box-shadow: var(--shadow-lift);
}
:root[data-theme="dark"] .plan { --step-complete: #86efac; }
header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px 8px 8px; }
header h2 { font-size: 14px; font-weight: 600; margin: 0; }
button { width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--text-dim); font-size: 20px; cursor: pointer; }
button:hover { background: var(--bg-elevated); color: var(--text-main); }
p { font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
.tasks, .subtasks { list-style: none; margin: 0; padding: 0; }
.tasks > li + li { border-top: 1px solid var(--border); }
.task-summary {
  display: block;
  position: relative;
  padding: 8px 30px 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  overflow-wrap: anywhere;
  list-style: none;
}
.task-summary::-webkit-details-marker { display: none; }
.task-summary:hover, details[open] > .task-summary { background: var(--bg-elevated); }
.task-summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.task-summary::after {
  content: "";
  position: absolute;
  top: 50%;
  right: 12px;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid var(--text-dim);
  border-bottom: 1.5px solid var(--text-dim);
  transform: translateY(-75%) rotate(45deg);
}
details[open] > .task-summary::after { transform: translateY(-25%) rotate(225deg); }
.task-meta { display: flex; align-items: baseline; gap: 8px; margin-top: 3px; font-variant-numeric: tabular-nums; }
.task-meta, .status { color: var(--text-dim); font-size: 12px; white-space: nowrap; }
.subtask-group { padding: 10px 10px 12px; }
.requirement { margin: 0 0 12px; color: var(--text-dim); }
.subtask + .subtask { margin-top: 12px; }
.subtask { display: flex; align-items: flex-start; gap: 8px; }
.step-marker {
  display: flex;
  flex: 0 0 16px;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  border: 1px solid var(--text-dim);
  border-radius: 50%;
  color: var(--step-complete);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}
.step-marker.complete { border-color: transparent; background: color-mix(in srgb, var(--step-complete) 14%, transparent); }
.subtask-content { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.task-summary strong, .subtask-name { display: block; font-weight: 600; }
.subtask-name { font-size: 12px; line-height: 18px; }
.subtask-message { margin: 2px 0 0; color: var(--text-dim); }
</style>
