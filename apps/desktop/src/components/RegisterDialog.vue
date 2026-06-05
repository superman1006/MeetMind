<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useAuthStore } from "../stores/auth.js";

// 注册悬浮窗:输入账号 / 密码 / 确认密码,调后端 user.registry 建号。
// 由父组件(LoginView)v-if 控制显隐;取消 → close 事件;注册成功 → registered 事件(带用户名),
// 父组件据此回到登录窗口、回填用户名、弹成功提示。注册本身不登录。
const emit = defineEmits<{ close: []; registered: [username: string] }>();
const auth = useAuthStore();

const username = ref("");
const password = ref("");
const confirm = ref("");
// 注册请求进行中:禁用按钮 + 输入,避免重复提交。
const submitting = ref(false);
// 内联错误文案(密码不一致 / 用户已存在 / 请求失败);空串 = 当前无错误。
const errorMsg = ref("");

// 三个输入都非空、且不在提交中,才允许点注册(两次密码是否一致放到提交时校验并给具体提示)。
const canSubmit = computed(() => {
  return (
    username.value.trim().length > 0 &&
    password.value.length > 0 &&
    confirm.value.length > 0 &&
    !submitting.value
  );
});

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

// Esc 关闭(提交进行中不关,避免误触打断)。
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && !submitting.value) {
    emit("close");
  }
}

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) {
    return;
  }
  // 客户端先校验两次密码一致,不一致就地提示、不发请求。
  if (password.value !== confirm.value) {
    errorMsg.value = "两次输入的密码不一致";
    return;
  }
  errorMsg.value = "";
  submitting.value = true;
  try {
    const name = username.value.trim();
    const result = await auth.register(name, password.value);
    if (!result.ok) {
      // 业务失败:目前只有「用户名已存在」一种,其余兜底一句通用提示。
      if (result.reason === "exists") {
        errorMsg.value = "该用户名已存在,请换一个";
      } else {
        errorMsg.value = "注册失败,请重试";
      }
      return;
    }
    // 注册成功:交给父组件回到登录窗口(回填用户名 + 成功提示)。
    emit("registered", name);
  } catch (e) {
    console.error("[RegisterDialog] 注册请求失败:", e);
    errorMsg.value = "注册请求失败,请检查服务是否启动";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <!-- 点遮罩空白处 = 关闭(提交中不关);点对话框本体不冒泡 -->
  <div class="overlay" @click="!submitting && emit('close')">
    <form class="dialog" @click.stop @submit.prevent="onSubmit">
      <h2 class="title">注册新账号</h2>
      <p class="hint">创建一个用于登录 MeetMind 的账号。注册成功后请用新账号登录。</p>

      <label class="field">
        <span class="label">账号</span>
        <input
          v-model="username"
          class="input"
          type="text"
          autocomplete="username"
          placeholder="请输入账号"
          autofocus
        />
      </label>

      <label class="field">
        <span class="label">密码</span>
        <input
          v-model="password"
          class="input"
          type="password"
          autocomplete="new-password"
          placeholder="请输入密码"
        />
      </label>

      <label class="field">
        <span class="label">确认密码</span>
        <input
          v-model="confirm"
          class="input"
          type="password"
          autocomplete="new-password"
          placeholder="请再次输入密码"
        />
      </label>

      <!-- 错误反馈:密码不一致 / 用户已存在 / 请求失败 -->
      <p v-if="errorMsg" class="result">{{ errorMsg }}</p>

      <div class="actions">
        <button class="btn cancel" type="button" :disabled="submitting" @click="emit('close')">取消</button>
        <button class="btn confirm" type="submit" :disabled="!canSubmit">
          {{ submitting ? "注册中…" : "注 册" }}
        </button>
      </div>
    </form>
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
  width: min(420px, calc(100vw - 48px));
  background: var(--bg-elevated);
  color: var(--text-main);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 24px 24px 18px;
  box-shadow: var(--shadow-lift);
}
.title { margin: 0 0 6px; font-size: 20px; font-weight: 700; }
.hint { margin: 0 0 18px; font-size: 13px; line-height: 1.5; color: var(--text-dim); }
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
.actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 6px; }
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
