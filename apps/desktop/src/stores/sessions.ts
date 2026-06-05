import { defineStore } from "pinia";
import { rpc } from "../api/rpcClient.js";
import { logUserAction } from "../api/logger.js";
import { useAuthStore } from "./auth.js";

export interface SessionMeta { id: string; title: string; created_at?: string; ended?: boolean }

export const useSessionsStore = defineStore("sessions", {
  state: () => ({
    list: [] as SessionMeta[],
    activeId: "" as string,
  }),
  actions: {
    /** 从服务端拉「当前用户自己」的会话列表;若没有选中项则默认选第一个。 */
    async load(): Promise<void> {
      const username = useAuthStore().username;
      const list = await rpc<SessionMeta[]>("session.list", { username });
      this.list = list;
      if (!this.activeId && list.length > 0) {
        this.activeId = list[0].id;
      }
    },
    /** 服务端新建一个会话(id 由服务端生成,归属当前用户),插到列表最前并选中。 */
    async newSession(): Promise<string> {
      const username = useAuthStore().username;
      const title = `会话 ${this.list.length + 1}`;
      logUserAction("新建会话", { title });
      const meta = await rpc<SessionMeta>("session.create", { title, username });
      this.list.unshift(meta);
      this.activeId = meta.id;
      return meta.id;
    },
    select(id: string): void {
      logUserAction("选择会话", { sessionId: id });
      this.activeId = id;
    },
    /** 重命名会话:服务端改 title,本地列表同步更新。 */
    async rename(id: string, title: string): Promise<void> {
      const trimmed = title.trim();
      if (!trimmed) {
        return;
      }
      logUserAction("重命名会话", { sessionId: id, title: trimmed });
      await rpc("session.rename", { sessionId: id, title: trimmed });
      for (const s of this.list) {
        if (s.id === id) {
          s.title = trimmed;
          return;
        }
      }
    },
    /** 只同步本地列表里某会话的标题(后端已通过别的 RPC 改过 DB,这里不再重复发 session.rename)。
     *  用于 chat.summaryTitle 自动生成标题后回填前端显示。未知 id 时静默忽略。 */
    setTitle(id: string, title: string): void {
      for (const s of this.list) {
        if (s.id === id) {
          s.title = title;
          return;
        }
      }
    },
    /** 删除会话(服务端级联删消息),并从列表移除;删的是当前会话则切到另一个。 */
    async remove(id: string): Promise<void> {
      logUserAction("删除会话", { sessionId: id });
      await rpc("session.delete", { sessionId: id });
      const remaining: SessionMeta[] = [];
      for (const s of this.list) {
        if (s.id !== id) {
          remaining.push(s);
        }
      }
      this.list = remaining;
      if (this.activeId === id) {
        if (this.list.length > 0) {
          this.activeId = this.list[0].id;
        } else {
          this.activeId = "";
        }
      }
    },
  },
});
