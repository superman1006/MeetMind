import { defineStore } from "pinia";

export interface SessionMeta { id: string; title: string }

export const useSessionsStore = defineStore("sessions", {
  state: () => ({
    list: [] as SessionMeta[],
    activeId: "" as string,
  }),
  actions: {
    newSession(): string {
      const id = crypto.randomUUID();
      const title = `会话 ${this.list.length + 1}`;
      this.list.unshift({ id, title });
      this.activeId = id;
      return id;
    },
    select(id: string): void {
      this.activeId = id;
    },
  },
});
