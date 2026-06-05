<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useAuthStore } from "../stores/auth.js";
import { useUiStore } from "../stores/ui.js";

// 用户记忆窗口:顶部标题「用户记忆」,下面一个大圆角文本框载入当前用户的 memory 供编辑,
// 右下角保存。由父组件 v-if 控制显隐,关闭通过 close 事件回传。
const emit = defineEmits<{ close: [] }>();
const auth = useAuthStore();
const ui = useUiStore();

const memory = ref(""); // 文本框内容,进窗口时由 user.getMemory 回填
const loading = ref(true); // 读取当前记忆中
const saving = ref(false);

// 进窗口:拉当前用户记忆回填(空串 = 还没写过记忆)。
onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  try {
    memory.value = await auth.getMemory();
  } catch (e) {
    console.error("[UserMemory] 读取记忆失败:", e);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

// Esc 关闭(保存进行中不关,避免误触打断)。
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && !saving.value) {
    emit("close");
  }
}

// 保存:整字段覆盖写回。空串合法(清空记忆)。
async function onSave(): Promise<void> {
  saving.value = true;
  try {
    await auth.setMemory(memory.value);
    ui.showToast("记忆已保存");
    emit("close");
  } catch (e) {
    console.error("[UserMemory] 保存失败:", e);
    ui.showToast("保存失败，请重试");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <!-- 点遮罩空白处 = 关闭(保存中不关);点对话框本体不冒泡 -->
  <div class="overlay" @click="!saving && emit('close')">
    <div class="dialog" @click.stop>
      <h2 class="title">用户记忆</h2>
      <p class="hint">这里记录你的个人偏好与背景,保存后随账号长期保留。</p>

      <div v-if="loading" class="loading">读取中…</div>

      <template v-else>
        <textarea
          v-model="memory"
          class="memo"
          placeholder="写下你希望长期记住的内容…"
          spellcheck="false"
        />

        <div class="actions">
          <div class="spacer" />
          <button class="btn cancel" :disabled="saving" @click="emit('close')">取消</button>
          <button class="btn confirm" :disabled="saving" @click="onSave">
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
  width: min(520px, calc(100vw - 48px));
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
/* 大圆角文本框:占窗口主体,纵向可拉伸 */
.memo {
  width: 100%;
  box-sizing: border-box;
  min-height: 220px;
  resize: vertical;
  background: var(--bg-app);
  color: var(--text-main);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 14px;
  line-height: 1.6;
  font-family: inherit;
  outline: none;
}
.memo:focus { border-color: var(--accent); }
.actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
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
.cancel { background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border); }
.cancel:not(:disabled):hover { filter: brightness(1.08); }
.confirm { background: var(--accent); color: #fff; }
.confirm:not(:disabled):hover { filter: brightness(1.08); }
</style>
