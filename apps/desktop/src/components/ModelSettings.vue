<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { rpc } from "../api/rpcClient.js";
import { logUserAction } from "../api/logger.js";
import { useUiStore } from "../stores/ui.js";

// LLM 模型配置面板:输入 baseUrl / apiKey / modelName，下发给 runtime 热切换模型。
// 由父组件 v-if 控制显隐;保存成功 / 取消都通过 close 事件回传。
const emit = defineEmits<{ close: [] }>();
const ui = useUiStore();

// 三个输入框。baseUrl / modelName 进面板时从 model.get 回填;apiKey 出于安全不回填明文,
// 留空表示"沿用已配置的 key",仅当用户真的输入新值时才覆盖。
const baseUrl = ref("");
const modelName = ref("");
const apiKey = ref("");
const apiKeySet = ref(false); // 后端是否已配置 key,决定 apiKey 输入框的 placeholder 文案

const loading = ref(true); // 拉当前配置中
const saving = ref(false);
const testing = ref(false);
// 测试连接结果:null 未测;ok 成功;否则 message 是错误原因。
const testResult = ref<{ ok: boolean; message?: string } | null>(null);

// 进面板:拉当前生效配置回填(apiKey 只拿到是否已设置)。
onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  try {
    const cfg = await rpc<{ baseUrl: string; modelName: string; apiKeySet: boolean }>("model.get", {});
    baseUrl.value = cfg.baseUrl;
    modelName.value = cfg.modelName;
    apiKeySet.value = cfg.apiKeySet;
  } catch (e) {
    console.error("[ModelSettings] 读取当前配置失败:", e);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

// Esc 关闭(保存/测试进行中不关,避免误触打断)。
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && !saving.value && !testing.value) {
    emit("close");
  }
}

// 组装要下发的字段:只带非空项(空 = 不修改该项)。
function buildPayload(): Record<string, string> {
  const payload: Record<string, string> = {};
  const url = baseUrl.value.trim();
  const model = modelName.value.trim();
  const key = apiKey.value.trim();
  if (url) {
    payload.baseUrl = url;
  }
  if (model) {
    payload.modelName = model;
  }
  if (key) {
    payload.apiKey = key;
  }
  return payload;
}

// 测试连接:用当前输入(留空回退到 runtime 现有配置)探一次连通性。
async function onTest(): Promise<void> {
  testResult.value = null;
  testing.value = true;
  logUserAction("测试模型连接");
  try {
    const res = await rpc<{ ok: boolean; message?: string }>("model.test", buildPayload());
    testResult.value = res;
  } catch (e) {
    testResult.value = { ok: false, message: String(e) };
  } finally {
    testing.value = false;
  }
}

// 保存:下发新配置,runtime 重建图,下一轮讨论生效。
async function onSave(): Promise<void> {
  const payload = buildPayload();
  // baseUrl / modelName 留空且未输入新 key → 没什么可改的,直接关。
  if (Object.keys(payload).length === 0) {
    emit("close");
    return;
  }
  saving.value = true;
  logUserAction("保存模型配置", { hasApiKey: Boolean(payload.apiKey), baseUrl: payload.baseUrl, modelName: payload.modelName });
  try {
    await rpc("model.set", payload);
    ui.showToast("模型配置已更新,下一轮讨论生效");
    emit("close");
  } catch (e) {
    console.error("[ModelSettings] 保存失败:", e);
    testResult.value = { ok: false, message: String(e) };
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <!-- 点遮罩空白处 = 关闭(保存/测试中不关);点对话框本体不冒泡 -->
  <div class="overlay" @click="!saving && !testing && emit('close')">
    <div class="dialog" @click.stop>
      <h2 class="title">模型配置</h2>
      <p class="hint">配置 OpenAI 兼容接口。保存后 runtime 会用新模型,下一轮讨论生效。</p>

      <div v-if="loading" class="loading">读取当前配置…</div>

      <template v-else>
        <label class="field">
          <span class="label">Base URL</span>
          <input v-model="baseUrl" class="input" type="text" placeholder="https://api.example.com/v1" spellcheck="false" />
        </label>

        <label class="field">
          <span class="label">Model Name</span>
          <input v-model="modelName" class="input" type="text" placeholder="如 gpt-4o-mini / MiMo-7B" spellcheck="false" />
        </label>

        <label class="field">
          <span class="label">API Key</span>
          <input
            v-model="apiKey"
            class="input"
            type="password"
            :placeholder="apiKeySet ? '已配置,留空则不修改' : '请输入 API Key'"
            spellcheck="false"
            autocomplete="off"
          />
        </label>

        <!-- 测试结果反馈 -->
        <p v-if="testResult" class="result" :class="{ ok: testResult.ok }">
          {{ testResult.ok ? "✓ 连接成功" : `✗ ${testResult.message ?? "连接失败"}` }}
        </p>

        <div class="actions">
          <button class="btn ghost" :disabled="testing || saving" @click="onTest">
            {{ testing ? "测试中…" : "测试连接" }}
          </button>
          <div class="spacer" />
          <button class="btn cancel" :disabled="saving || testing" @click="emit('close')">取消</button>
          <button class="btn confirm" :disabled="saving || testing" @click="onSave">
            {{ saving ? "保存中…" : "保存" }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.dialog {
  width: min(460px, calc(100vw - 48px));
  background: var(--bg-elevated);
  color: var(--text-main);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 24px 24px 18px;
  box-shadow: var(--shadow-lift);
}
.title { margin: 0 0 6px; font-size: 20px; font-weight: 700; }
.hint { margin: 0 0 18px; font-size: 13px; line-height: 1.5; color: var(--text-dim); }
.loading { padding: 24px 0; text-align: center; color: var(--text-dim); font-size: 14px; }
.field { display: block; margin-bottom: 14px; }
.label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: var(--text-dim); }
.input {
  width: 100%;
  background: var(--bg-app);
  color: var(--text-main);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 9px 11px;
  font-size: 14px;
  font-family: inherit;
  outline: none;
}
.input:focus { border-color: var(--accent); }
.result { margin: 4px 0 14px; font-size: 13px; line-height: 1.5; color: #e0483d; word-break: break-all; }
.result.ok { color: #16a34a; }
.actions { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.spacer { flex: 1; }
.btn {
  padding: 9px 18px;
  border: none;
  border-radius: 9px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.ghost { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
.ghost:not(:disabled):hover { background: var(--accent-soft); }
.cancel { background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border); }
.cancel:not(:disabled):hover { filter: brightness(1.08); }
.confirm { background: var(--accent); color: #fff; }
.confirm:not(:disabled):hover { filter: brightness(1.08); }
</style>
