<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { rpc } from "../api/rpcClient.js";
import { useAuthStore } from "../stores/auth.js";
import { useSessionsStore } from "../stores/sessions.js";
import MeetingDialog from "./MeetingDialog.vue";

interface Participant { username: string; display_name: string; is_seed: boolean }

const emit = defineEmits<{ close: []; created: [] }>();
const auth = useAuthStore();
const sessions = useSessionsStore();
const title = ref("");
const search = ref("");
const selected = ref<string[]>([]);
const participants = ref<Participant[]>([]);
const loading = ref(true);
const creating = ref(false);
const error = ref("");
// 主持人已默认加入会议，从可勾选的数字人里排除当前账号。
const matches = computed(() => {
  const query = search.value.trim().toLowerCase();
  return participants.value.filter((person) =>
    person.username !== auth.username &&
    (person.username.toLowerCase().includes(query) || person.display_name.toLowerCase().includes(query)),
  );
});

onMounted(async () => {
  try {
    participants.value = await rpc<Participant[]>("twin.list", {});
  } catch (failure) {
    error.value = String(failure);
  } finally {
    loading.value = false;
  }
});

async function create(): Promise<void> {
  if (creating.value || loading.value) return;
  creating.value = true;
  error.value = "";
  try {
    // 会话 Store 调用创建接口，并在成功后选中新会议。
    await sessions.newSession(selected.value, title.value.trim());
    emit("created");
  } catch (failure) {
    error.value = String(failure);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <MeetingDialog title="新会话" @close="emit('close')">
    <form id="new-meeting" class="meeting-form" @submit.prevent="create">
      <label class="field">会议名称 <input v-model="title" maxlength="200" placeholder="新会话" /></label>
      <div class="host"><span>主持人</span><strong>{{ auth.username }}（你）</strong></div>
      <label class="field">选择参会数字人 <input v-model="search" type="search" placeholder="搜索名称或账号" /></label>
      <p v-if="loading" role="status">正在加载参会人…</p>
      <p v-else-if="!matches.length" class="hint">没有匹配的数字人</p>
      <div v-else class="roster">
        <label v-for="person in matches" :key="person.username" class="person">
          <input v-model="selected" type="checkbox" :value="person.username" />
          <span><strong>{{ person.display_name }}</strong><small v-if="person.username !== person.display_name">{{ person.username }}</small></span>
        </label>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <span class="hint">已选 {{ selected.length }} 位参会人</span>
      <button class="primary" type="submit" form="new-meeting" :disabled="loading || creating">创建会议</button>
    </template>
  </MeetingDialog>
</template>

<style scoped>
.meeting-form, .field { display: grid; gap: 8px; }
.meeting-form { gap: 14px; }
.field, .host { font-size: 13px; }
.field input { color: var(--text-main); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 7px; padding: 8px 10px; font: inherit; }
.host { display: flex; gap: 12px; color: var(--text-dim); }
.host strong, .person strong { color: var(--text-main); font-weight: 600; }
.roster { max-height: 244px; overflow: auto; border-block: 1px solid var(--border); }
.person { display: flex; align-items: center; gap: 9px; min-height: 41px; border-bottom: 1px solid var(--border); font-size: 13px; padding: 5px 2px; cursor: pointer; }
.person:last-child { border: 0; }
.person small { color: var(--text-dim); margin-left: 8px; }
.hint { color: var(--text-dim); font-size: 12px; }
.error { color: #c24134; margin: 0; }
.primary { background: var(--accent); color: white; border: 0; border-radius: 7px; padding: 8px 14px; cursor: pointer; }
.primary:disabled { opacity: .55; cursor: default; }
</style>
