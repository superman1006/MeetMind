import { defineStore } from "pinia";
import { rpc } from "../api/rpcClient.js";

export interface SessionMeta { id: string; title: string; created_at?: string }

export const useSessionsStore = defineStore("sessions", {
  state: () => ({
    list: [] as SessionMeta[],
    activeId: "" as string,
  }),
  actions: {
    /** 从服务端拉会话列表;若没有选中项则默认选第一个。 */
    async load(): Promise<void> {
      const list = await rpc<SessionMeta[]>("session.list", {});
      this.list = list;
      if (!this.activeId && list.length > 0) {
        this.activeId = list[0].id;
      }
    },
    /** 服务端新建一个会话(id 由服务端生成),插到列表最前并选中。 */
    async newSession(): Promise<string> {
      const title = `会话 ${this.list.length + 1}`;
      const meta = await rpc<SessionMeta>("session.create", { title });
      this.list.unshift(meta);
      this.activeId = meta.id;
      return meta.id;
    },
    select(id: string): void {
      this.activeId = id;
    },
    /** 删除会话(服务端级联删消息),并从列表移除;删的是当前会话则切到另一个。 */
    async remove(id: string): Promise<void> {
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
