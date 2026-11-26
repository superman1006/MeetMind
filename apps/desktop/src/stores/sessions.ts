import { defineStore } from "pinia";
import { rpc } from "../api/rpcClient.js";
import { logUserAction } from "../api/logger.js";
import { useAuthStore } from "./auth.js";

export interface SessionMeta {
  id: string;
  title: string;
  created_at?: string;
  ended?: boolean;
  archived?: boolean;
  isHost?: boolean;
  owner?: string;
  participants?: string[];
  running?: boolean;
  minutesStatus?: "pending" | "writing" | "completed" | "failed" | null;
  minutesFilename?: string | null;
}

export const useSessionsStore = defineStore("sessions", {
  state: () => ({
    list: [] as SessionMeta[],
    activeId: "" as string,
  }),
  actions: {
    /** 从服务端拉「当前用户自己」的会话列表;若没有选中项则默认选第一个。 */
    async load(): Promise<void> {
      const auth = useAuthStore();
      const username = auth.username;
      const list = await rpc<SessionMeta[]>("session.list", {});
      // 登录账号可能在请求期间切换，丢弃旧账号的会话列表。
      if (auth.username !== username) return;
      this.list = list;
      if (!list.some((record) => record.id === this.activeId)) {
        this.activeId = list.find((record) => !record.archived)?.id ?? "";
      }
    },
    /** 服务端新建一个会话(id 由服务端生成,归属当前用户),插到列表最前并选中。 */
    async newSession(participants: string[], title: string): Promise<string> {
      logUserAction("新建会话", { title });
      const meta = await rpc<SessionMeta>("session.create", { title, participants });
      if (!this.list.some((record) => record.id === meta.id)) this.list.unshift(meta);
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
    async archive(sessionId: string, archived: boolean): Promise<void> {
      await rpc("session.archive", { sessionId, archived });
      const meeting = this.list.find((record) => record.id === sessionId);
      if (meeting) meeting.archived = archived;
    },
  },
});
