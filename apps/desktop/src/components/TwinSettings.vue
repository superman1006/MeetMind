<script setup lang="ts">
import { onMounted, ref } from "vue";
import { rpc } from "../api/rpcClient.js";
import MeetingDialog from "./MeetingDialog.vue";

interface Profile { display_name: string; persona: string; memory: string; tools: string[]; skills: string[] }
interface Capability { name: string; description: string; risk?: string }
interface KnowledgeFile { filename: string; chunks: number }

const emit = defineEmits<{ close: [] }>();
const tab = ref<"profile" | "capabilities" | "knowledge">("profile");
const profile = ref<Profile | null>(null);
const tools = ref<Capability[]>([]);
const skills = ref<Capability[]>([]);
const files = ref<KnowledgeFile[] | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const error = ref("");
const notice = ref("");
const saving = ref(false);
const uploading = ref(false);
const loadingFiles = ref(false);

// 账号配置与可选能力目录独立读取，目录提供工具和技能的名称及说明。
onMounted(async () => {
  try {
    const [account, catalog] = await Promise.all([
      rpc<Profile>("twin.getProfile", {}),
      rpc<{ tools: Capability[]; skills: Capability[] }>("twin.catalog", {}),
    ]);
    profile.value = account;
    tools.value = catalog.tools;
    skills.value = catalog.skills;
  } catch (failure) {
    error.value = String(failure);
  }
});

function selectAll(group: "tools" | "skills", entries: Capability[]): void {
  const account = profile.value;
  if (!account) return;
  const selected = new Set(account[group]);
  for (const entry of entries) {
    selected.add(entry.name);
  }
  account[group] = [...selected];
}

async function save(): Promise<void> {
  if (!profile.value || saving.value) return;
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    const updated = { ...profile.value };
    await rpc("twin.setProfile", updated);
    notice.value = "设置已保存";
  } catch (failure) {
    error.value = String(failure);
  } finally {
    saving.value = false;
  }
}

async function showKnowledge(): Promise<void> {
  tab.value = "knowledge";
  loadingFiles.value = true;
  error.value = "";
  notice.value = "";
  try {
    files.value = await rpc<KnowledgeFile[]>("twin.listKnowledge", {});
  } catch (failure) {
    error.value = String(failure);
  } finally {
    loadingFiles.value = false;
  }
}

// FileReader 返回的是 Data URL，上传接口只接收逗号后的 Base64 内容。
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result);
      resolve(raw.slice(raw.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function upload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || uploading.value) return;
  error.value = "";
  notice.value = "";
  if (!file.size || file.size > 10 * 1024 * 1024) {
    error.value = "请选择不超过 10 MiB 的非空文件";
    return;
  }

  uploading.value = true;
  try {
    const contentBase64 = await readBase64(file);
    const result = await rpc<{ chunks: number }>("twin.uploadKnowledge", { filename: file.name, contentBase64 });
    files.value = await rpc<KnowledgeFile[]>("twin.listKnowledge", {});
    notice.value = result.chunks ? `已导入 ${result.chunks} 个文本块` : "该文件的内容已在知识库中";
  } catch (failure) {
    error.value = String(failure);
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <MeetingDialog title="数字人设置" @close="emit('close')">
    <nav class="tabs" aria-label="数字人设置">
      <button type="button" :aria-pressed="tab === 'profile'" @click="tab = 'profile'">简介与记忆</button>
      <button type="button" :aria-pressed="tab === 'capabilities'" @click="tab = 'capabilities'">工具与 Skills</button>
      <button type="button" :aria-pressed="tab === 'knowledge'" @click="showKnowledge">知识库</button>
    </nav>

    <div v-if="tab === 'profile' && profile" class="fields">
      <label>数字人名称 <input v-model="profile.display_name" maxlength="100" /></label>
      <label>简介 <textarea v-model="profile.persona" rows="3" maxlength="4000" /></label>
      <label>用户记忆 <textarea v-model="profile.memory" rows="5" maxlength="32000" /></label>
    </div>
    <div v-if="tab === 'capabilities' && profile" class="capabilities">
      <fieldset>
        <legend>工具</legend>
        <button
          type="button"
          class="select-all"
          aria-label="全选工具"
          :disabled="tools.every((entry) => profile?.tools.includes(entry.name))"
          @click="selectAll('tools', tools)"
        >全选</button>
        <label v-for="entry in tools" :key="entry.name" :title="entry.description">
          <input v-model="profile.tools" type="checkbox" :value="entry.name" />
          {{ entry.name }} <small v-if="entry.risk !== 'low'">使用前需审批</small>
        </label>
      </fieldset>
      <fieldset>
        <legend>Skills</legend>
        <button
          type="button"
          class="select-all"
          aria-label="全选 Skills"
          :disabled="skills.every((entry) => profile?.skills.includes(entry.name))"
          @click="selectAll('skills', skills)"
        >全选</button>
        <label v-for="entry in skills" :key="entry.name" :title="entry.description">
          <input v-model="profile.skills" type="checkbox" :value="entry.name" /> {{ entry.name }}
        </label>
      </fieldset>
    </div>
    <div v-if="tab === 'knowledge'" class="knowledge">
      <section class="knowledge-import" aria-labelledby="knowledge-import-title">
        <div class="import-copy">
          <h3 id="knowledge-import-title">导入知识文件</h3>
          <p id="knowledge-import-formats">PDF、DOCX、TXT、Markdown、JSON<br />单个文件最大 10 MiB</p>
        </div>
        <input ref="fileInput" type="file" accept=".txt,.md,.markdown,.json,.pdf,.docx" hidden :disabled="uploading" @change="upload" />
        <button
          type="button"
          class="primary import-button"
          aria-describedby="knowledge-import-formats"
          :disabled="uploading"
          @click="fileInput?.click()"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 15V3m-4 4 4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
          </svg>
          {{ uploading ? "导入中…" : "选择并导入" }}
        </button>
        <p v-if="uploading" class="import-status" role="status">正在解析文件并建立检索索引</p>
        <p v-else-if="error" class="import-status error" role="alert">{{ error }}</p>
        <p v-else-if="notice" class="import-status" role="status">{{ notice }}</p>
      </section>

      <section aria-labelledby="knowledge-files-title">
        <div class="files-heading">
          <h3 id="knowledge-files-title">已导入文件</h3>
          <span v-if="files?.length">{{ files.length }} 个文件</span>
        </div>
        <ul v-if="files?.length" class="files" role="list">
          <li v-for="file in files" :key="file.filename" class="file-row">
            <span class="file-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9zm0 0v7h7M8 14h8m-8 3h5" />
              </svg>
            </span>
            <span class="file-name" :title="file.filename">{{ file.filename }}</span>
            <span class="file-chunks"><strong>{{ file.chunks }}</strong><small>文本块</small></span>
          </li>
        </ul>
        <p v-else-if="loadingFiles" class="files-state" role="status">正在读取知识库…</p>
        <p v-else-if="files" class="files-state">还没有导入文件</p>
      </section>
    </div>
    <template v-else>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    </template>
    <template v-if="tab !== 'knowledge'" #footer>
      <button class="primary" :disabled="!profile || saving" @click="save">保存设置</button>
    </template>
  </MeetingDialog>
</template>

<style scoped>
.tabs { display: flex; gap: 16px; margin-bottom: 17px; border-bottom: 1px solid var(--border); }
.tabs button { border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-dim); padding: 5px 0 8px; cursor: pointer; }
.tabs button[aria-pressed="true"] { color: var(--text-main); border-color: var(--accent); }
.fields, .fields label { display: grid; gap: 7px; font-size: 13px; }
.fields { gap: 13px; }
.fields input, .fields textarea { color: var(--text-main); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 7px; padding: 8px 10px; font: inherit; resize: vertical; }
.capabilities { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; font-size: 13px; }
fieldset { border: 1px solid var(--border); border-radius: 7px; padding: 8px; min-width: 0; }
fieldset label { display: block; padding: 4px 0; overflow-wrap: anywhere; }
.select-all { display: block; margin-inline-start: auto; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text-main); padding: 4px 8px; font: inherit; cursor: pointer; }
.select-all:not(:disabled):hover { background: var(--bg-elevated); }
.select-all:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.select-all:disabled { color: var(--text-dim); cursor: default; }
small, .notice { color: var(--text-dim); font-size: 12px; }
.knowledge { display: grid; gap: 24px; }
.knowledge h3 { margin: 0; font-size: 14px; font-weight: 600; }
.knowledge-import {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 16px;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 6%, var(--bg-chat));
}
.import-copy p { margin: 4px 0 0; color: var(--text-dim); font-size: 12px; line-height: 1.6; }
.knowledge-import .import-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--accent) 88%, black);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.import-button:not(:disabled):hover { background: color-mix(in srgb, var(--accent) 76%, black); }
.import-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.import-button svg, .file-icon svg { width: 16px; height: 16px; flex-shrink: 0; }
.import-status {
  grid-column: 1 / -1;
  margin: 0;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  color: var(--text-main);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.knowledge-import .error { color: var(--knowledge-error, #a92822); font-size: 12px; }
:root[data-theme="dark"] .knowledge { --knowledge-error: #fca5a5; }
.files-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.files-heading span { color: var(--text-dim); font-size: 12px; font-variant-numeric: tabular-nums; }
.files, .files-state { margin: 0; border: 1px solid var(--border); border-radius: 12px; }
.files { padding: 0; list-style: none; }
.file-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px;
}
.file-row + .file-row { border-top: 1px solid var(--border); }
.file-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: var(--bg-elevated);
  color: var(--text-dim);
}
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
.file-chunks { display: grid; justify-items: end; gap: 2px; font-variant-numeric: tabular-nums; }
.file-chunks strong { font-size: 14px; font-weight: 600; }
.file-chunks small { font-size: 11px; white-space: nowrap; }
.files-state { padding: 20px 12px; color: var(--text-dim); text-align: center; font-size: 12px; }
@media (max-width: 480px) {
  .knowledge-import { grid-template-columns: minmax(0, 1fr); justify-items: start; }
  .import-status { width: 100%; }
}
.error { color: #c24134; font-size: 13px; }
.primary { background: var(--accent); color: white; border: 0; border-radius: 7px; padding: 8px 14px; cursor: pointer; }
.primary:disabled { opacity: .55; cursor: default; }
</style>
