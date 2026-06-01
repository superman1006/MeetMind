import { defineStore } from "pinia";

export interface Bubble {
  turnId: string;
  agent_name: string;
  role: string;
  text: string;
  isUser: boolean;
  done: boolean;
  used_rag: boolean;
}

interface ChatState {
  bubblesBySession: Record<string, Bubble[]>;
  busyBySession: Record<string, boolean>;
}

export const useChatStore = defineStore("chat", {
  state: (): ChatState => ({
    bubblesBySession: {},
    busyBySession: {},
  }),
  getters: {
    bubblesOf: (state) => (sessionId: string) => state.bubblesBySession[sessionId] ?? [],
    isBusy: (state) => (sessionId: string) => state.busyBySession[sessionId] ?? false,
  },
  actions: {
    ensure(sessionId: string): void {
      if (!this.bubblesBySession[sessionId]) {
        this.bubblesBySession[sessionId] = [];
      }
    },
    addUser(sessionId: string, text: string): void {
      this.ensure(sessionId);
      const n = this.bubblesBySession[sessionId].length;
      this.bubblesBySession[sessionId].push({
        turnId: `user-${n}`,
        agent_name: "user",
        role: "用户",
        text,
        isUser: true,
        done: false,
        used_rag: false,
      });
      this.busyBySession[sessionId] = true;
    },
    startTurn(sessionId: string, turnId: string, agentName: string, role: string): void {
      this.ensure(sessionId);
      this.bubblesBySession[sessionId].push({
        turnId,
        agent_name: agentName,
        role,
        text: "",
        isUser: false,
        done: false,
        used_rag: false,
      });
    },
    appendDelta(sessionId: string, turnId: string, text: string): void {
      const bubbles = this.bubblesBySession[sessionId] ?? [];
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i].turnId === turnId) {
          bubbles[i].text += text;
          return;
        }
      }
    },
    endTurn(sessionId: string, turnId: string, usedRag: boolean): void {
      const bubbles = this.bubblesBySession[sessionId] ?? [];
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i].turnId === turnId) {
          bubbles[i].used_rag = usedRag;
          return;
        }
      }
    },
    finishRound(sessionId: string): void {
      this.busyBySession[sessionId] = false;
    },
    addErrorBubble(sessionId: string, message: string): void {
      this.ensure(sessionId);
      this.bubblesBySession[sessionId].push({
        turnId: `error-${this.bubblesBySession[sessionId].length}`,
        agent_name: "architect",
        role: "系统",
        text: `⚠️ ${message}`,
        isUser: false,
        done: false,
        used_rag: false,
      });
      this.busyBySession[sessionId] = false;
    },
  },
});
