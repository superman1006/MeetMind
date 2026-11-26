import { defineStore } from "pinia";
import { rpc } from "../api/rpcClient.js";

export const useAuthStore = defineStore("auth", {
  state: () => ({ username: "" }),
  getters: {
    loggedIn: (state) => Boolean(state.username),
  },
  actions: {
    async initAuth(): Promise<void> {
      try {
        const account = await rpc<{ username: string }>("user.me", {});
        this.username = account.username;
      } catch {
        this.clearLogin();
      }
    },
    async login(username: string, password: string): Promise<boolean> {
      const result = await rpc<{ ok: boolean; username?: string }>("user.login", { username, password });
      if (!result.ok) return false;
      this.username = result.username ?? username;
      return true;
    },
    async register(username: string, password: string): Promise<{ ok: boolean; reason?: "exists" }> {
      return rpc("user.registry", { username, password });
    },
    clearLogin(): void {
      this.username = "";
    },
    async logout(): Promise<void> {
      await rpc("user.logout", {});
      this.clearLogin();
    },
  },
});
