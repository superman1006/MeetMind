<script setup lang="ts">
import { ref, computed } from "vue";
import { useAuthStore } from "../stores/auth.js";
import { useUiStore } from "../stores/ui.js";
import RegisterDialog from "./RegisterDialog.vue";

const auth = useAuthStore();
const ui = useUiStore();

const username = ref("");
const password = ref("");
// 登录请求进行中:禁用按钮 + 输入,避免重复提交。
const submitting = ref(false);
// 注册悬浮窗显隐:点「注册」打开,取消 / 注册成功后关闭。
const showRegister = ref(false);

// 注册成功:回到登录窗口——关弹窗、回填刚注册的用户名、清空密码、弹成功提示,让用户直接登录。
function onRegistered(name: string): void {
  showRegister.value = false;
  username.value = name;
  password.value = "";
  ui.showToast("注册成功，请登录");
}

// 两个输入都非空、且不在提交中,才允许登录。
const canSubmit = computed(() => {
  return username.value.trim().length > 0 && password.value.length > 0 && !submitting.value;
});

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) {
    return;
  }
  submitting.value = true;
  try {
    const ok = await auth.login(username.value.trim(), password.value);
    if (!ok) {
      // 账号或密码错误:沿用全局 Toast 弹窗提示,清空密码,焦点不动让用户重试。
      ui.showToast("账号或密码错误，请重试");
      password.value = "";
    }
    // 成功无需跳转:App.vue 监听 auth.loggedIn,变 true 自动切到会话界面。
  } catch (e) {
    console.error("[LoginView] 登录请求失败:", e);
    ui.showToast("登录请求失败，请检查服务是否启动");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login">
    <form class="card" @submit.prevent="onSubmit">
      <div class="brand">
        <div class="logo">M</div>
        <h1 class="app-name">MeetMind</h1>
        <p class="subtitle">多 Agent 协作讨论 · 请登录</p>
      </div>

      <label class="field">
        <span class="label">用户名</span>
        <input
          v-model="username"
          class="input"
          type="text"
          autocomplete="username"
          placeholder="请输入用户名"
          autofocus
        />
      </label>

      <label class="field">
        <span class="label">密码</span>
        <input
          v-model="password"
          class="input"
          type="password"
          autocomplete="current-password"
          placeholder="请输入密码"
        />
      </label>

      <button class="submit" type="submit" :disabled="!canSubmit">
        {{ submitting ? "登录中…" : "登 录" }}
      </button>

      <!-- 没有账号 → 打开注册悬浮窗 -->
      <p class="register-hint">
        还没有账号?
        <button class="register-link" type="button" @click="showRegister = true">注册</button>
      </p>
    </form>

    <!-- 注册悬浮窗:注册成功回到登录窗口(onRegistered) -->
    <RegisterDialog
      v-if="showRegister"
      @close="showRegister = false"
      @registered="onRegistered"
    />
  </div>
</template>

<style scoped>
.login {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-app);
  padding: 24px;
}
/* 登录卡片:亮于背景的卡片色 + 细边 + 抬升阴影,与现有侧栏卡片风格一致 */
.card {
  width: 340px;
  max-width: 100%;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow-lift);
  padding: 32px 28px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.brand { display: flex; flex-direction: column; align-items: center; gap: 6px; margin-bottom: 6px; }
/* 圆角方形 logo,实心强调色 */
.logo {
  width: 52px; height: 52px; border-radius: 14px;
  background: var(--accent); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 26px; font-weight: 700;
  box-shadow: var(--shadow-card);
}
.app-name { margin: 4px 0 0; font-size: 22px; font-weight: 700; color: var(--text-main); }
.subtitle { margin: 0; font-size: 13px; color: var(--text-dim); }
.field { display: flex; flex-direction: column; gap: 6px; }
.label { font-size: 13px; font-weight: 600; color: var(--text-dim); }
/* 输入框:贴合应用底色 + 聚焦时强调色边框 */
.input {
  background: var(--bg-app);
  color: var(--text-main);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 11px 12px;
  font-size: 14px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.input::placeholder { color: var(--text-dim); opacity: 0.7; }
/* 登录按钮:实心强调色,与「+ 新会话」按钮同款交互(上浮 + 阴影) */
.submit {
  margin-top: 4px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 10px;
  padding: 12px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 1px;
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
}
.submit:hover:not(:disabled) { transform: translateY(-2px); box-shadow: var(--shadow-lift); filter: brightness(1.05); }
.submit:active:not(:disabled) { transform: translateY(0); box-shadow: var(--shadow-card); }
.submit:disabled { opacity: 0.55; cursor: not-allowed; }
/* 「还没有账号? 注册」一行:次要文案 + 文字按钮,不抢登录按钮的视觉重量 */
.register-hint { margin: 2px 0 0; text-align: center; font-size: 13px; color: var(--text-dim); }
.register-link {
  background: none;
  border: none;
  padding: 0 2px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  color: var(--accent);
  cursor: pointer;
}
.register-link:hover { text-decoration: underline; }
</style>
