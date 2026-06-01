import { defineStore } from "pinia";

export interface Bubble {
  turnId: string;
  agent_name: string;
  role: string;
  text: string;
  isUser: boolean;
  done: boolean;
  used_rag: boolean;
  usingTools: boolean;  // 正在调工具(Phase 1),显示 UsingTools 标签
  tool: string;         // 当前/最近调用的工具名
}

/** 从 DB 取回的一条历史消息(AgentResponse 的子集),用于 load 时还原气泡。 */
export interface StoredTurn {
  agent_name: string;
  role: string;
  message: string;
  next_agent: string | null;
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
        usingTools: false,
        tool: "",
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
        usingTools: false,
        tool: "",
      });
    },
    useTool(sessionId: string, turnId: string, tool: string): void {
      const bubbles = this.bubblesBySession[sessionId] ?? [];
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i].turnId === turnId) {
          bubbles[i].usingTools = true;
          bubbles[i].tool = tool;
          return;
        }
      }
    },
    appendDelta(sessionId: string, turnId: string, text: string): void {
      const bubbles = this.bubblesBySession[sessionId] ?? [];
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i].turnId === turnId) {
          bubbles[i].text += text;
          // 开始吐字 = 工具已用完,撤掉 UsingTools 标签
          bubbles[i].usingTools = false;
          return;
        }
      }
    },
    endTurn(sessionId: string, turnId: string, usedRag: boolean): void {
      const bubbles = this.bubblesBySession[sessionId] ?? [];
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i].turnId === turnId) {
          bubbles[i].used_rag = usedRag;
          bubbles[i].usingTools = false;
          return;
        }
      }
    },
    finishRound(sessionId: string): void {
      this.busyBySession[sessionId] = false;
    },
    /** 用从 DB 取回的历史消息覆盖某会话的气泡(切换/打开会话时调)。 */
    load(sessionId: string, turns: StoredTurn[]): void {
      const bubbles: Bubble[] = [];
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        bubbles.push({
          turnId: `hist-${i}`,
          agent_name: t.agent_name,
          role: t.role,
          text: t.message,
          isUser: t.agent_name === "user",
          done: t.done,
          used_rag: t.used_rag,
          usingTools: false,
          tool: "",
        });
      }
      this.bubblesBySession[sessionId] = bubbles;
    },
    /** 丢弃某会话的本地气泡(删除会话时调)。 */
    drop(sessionId: string): void {
      delete this.bubblesBySession[sessionId];
      delete this.busyBySession[sessionId];
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
        usingTools: false,
        tool: "",
      });
      this.busyBySession[sessionId] = false;
    },
  },
});
