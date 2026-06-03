import { defineStore } from "pinia";

export interface Bubble {
  turnId: string;
  agent_name: string;
  role: string;
  text: string;
  isUser: boolean;
  done: boolean;
  used_rag: boolean;
  tool: string;  // 本轮用过的工具名(非空即一直显示 "UsingTools: <tool>",回答结束也保留)
  createdAt: number;  // 消息出现时间(epoch 毫秒),仅前端展示用,不落库
}

/** 从 DB 取回的一条历史消息(AgentResponse 的子集),用于 load 时还原气泡。 */
export interface StoredTurn {
  agent_name: string;
  role: string;
  message: string;
  next_agent: string | null;
  done: boolean;
  used_rag: boolean;
  tool: string;
  created_at?: string;  // DB 里这条消息的写入时间;历史气泡用它显示真实发送时间
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
        tool: "",
        createdAt: Date.now(),
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
        tool: "",
        createdAt: Date.now(),
      });
    },
    useTool(sessionId: string, turnId: string, tool: string): void {
      const bubbles = this.bubblesBySession[sessionId] ?? [];
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i].turnId === turnId) {
          // 累加显示用过的工具(去重),回答结束也不清除
          const existing = bubbles[i].tool;
          if (!existing) {
            bubbles[i].tool = tool;
          } else if (!existing.split(", ").includes(tool)) {
            bubbles[i].tool = `${existing}, ${tool}`;
          }
          return;
        }
      }
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
      // 本轮结束(正常跑完或被用户打断):删掉末尾那个「已建但一个字都没吐出」的 agent 占位气泡。
      // 它的 text 为空 → MessageBubble 会一直显示流动点(thinking),不删就停不下来。
      // 被打断的本轮本就不落库,删掉这种空气泡正合适。
      const bubbles = this.bubblesBySession[sessionId];
      if (!bubbles) {
        return;
      }
      while (bubbles.length > 0) {
        const last = bubbles[bubbles.length - 1];
        if (!last.isUser && last.text.length === 0) {
          bubbles.pop();
        } else {
          break;
        }
      }
    },
    /** 用从 DB 取回的历史消息覆盖某会话的气泡(切换/打开会话时调)。 */
    load(sessionId: string, turns: StoredTurn[]): void {
      const bubbles: Bubble[] = [];
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        // 历史气泡优先用 DB 里这条消息的写入时间;旧数据没有该字段时退回当前时间。
        let createdAt = Date.now();
        if (t.created_at) {
          const parsed = new Date(t.created_at).getTime();
          if (!Number.isNaN(parsed)) {
            createdAt = parsed;
          }
        }
        bubbles.push({
          turnId: `hist-${i}`,
          agent_name: t.agent_name,
          role: t.role,
          text: t.message,
          isUser: t.agent_name === "user",
          done: t.done,
          used_rag: t.used_rag,
          tool: t.tool ?? "",
          createdAt,
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
        tool: "",
        createdAt: Date.now(),
      });
      this.busyBySession[sessionId] = false;
    },
  },
});
