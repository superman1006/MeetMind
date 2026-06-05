import { defineStore } from "pinia";
import { rpc } from "../api/rpcClient.js";
import { logUserAction } from "../api/logger.js";

// localStorage 的键:登录成功后存当前用户名,刷新/重启后免登录。
const STORAGE_KEY = "meetmind-user";

// 登录态:当前登录用户名(空字符串 = 未登录)。独立成 store,App.vue 据此在登录页 / 会话界面间切换。
export const useAuthStore = defineStore("auth", {
  state: () => ({
    username: "" as string,
  }),
  getters: {
    // 用户名非空即视为已登录。
    loggedIn(state): boolean {
      return state.username.length > 0;
    },
  },
  actions: {
    // 启动时调用(main.ts,mount 前):从 localStorage 恢复登录态,避免刷新就被踢回登录页。
    initAuth(): void {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(STORAGE_KEY);
      } catch {
        // 隐私模式等 localStorage 不可用:当作未登录
        saved = null;
      }
      this.username = saved ?? "";
    },
    /**
     * 发起登录:调后端 user.login。
     * 成功返回 true 并记住用户名(内存 + localStorage);账号或密码错误返回 false。
     */
    async login(username: string, password: string): Promise<boolean> {
      logUserAction("登录", { username });
      const result = await rpc<{ ok: boolean; username?: string }>("user.login", { username, password });
      if (!result.ok) {
        return false;
      }
      const name = result.username ?? username;
      this.username = name;
      try {
        localStorage.setItem(STORAGE_KEY, name);
      } catch {
        // 不可用就只记内存,不抛错
      }
      return true;
    },
    /**
     * 注册新用户:调后端 user.registry。
     * 成功回 { ok:true };用户名已存在回 { ok:false, reason:"exists" }。
     * 注册不自动登录——不动 username,前端据此停在登录页让用户用新账号登录。
     */
    async register(username: string, password: string): Promise<{ ok: boolean; reason?: "exists" }> {
      logUserAction("注册", { username });
      const result = await rpc<{ ok: boolean; reason?: "exists" }>("user.registry", { username, password });
      return result;
    },
    /**
     * 读取当前登录用户的个人记忆:调后端 user.getMemory,返回 memory 文本(可能为空串)。
     * 用户记忆窗口打开时调用,回填到文本框。
     */
    async getMemory(): Promise<string> {
      logUserAction("读取用户记忆", { username: this.username });
      const result = await rpc<{ memory: string }>("user.getMemory", { username: this.username });
      return result.memory;
    },
    /**
     * 保存当前登录用户的个人记忆:调后端 user.setMemory 整字段覆盖。空串合法(清空记忆)。
     */
    async setMemory(memory: string): Promise<void> {
      logUserAction("保存用户记忆", { username: this.username });
      await rpc("user.setMemory", { username: this.username, memory });
    },
    // 登出:清内存 + 清 localStorage,App.vue 据此切回登录页。
    logout(): void {
      logUserAction("登出", { username: this.username });
      this.username = "";
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // 不可用就只清内存
      }
    },
  },
});
