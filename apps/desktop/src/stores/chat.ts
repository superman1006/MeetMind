import { defineStore } from "pinia";

/** 一次工具调用的明细：工具名 + 入参 + 返回结果。与后端 AgentResponse.tool_calls 同构。 */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export interface Bubble {
  turnId: string;
  agent_name: string;
  role: string;
  text: string;
  isUser: boolean;
  done: boolean;
  used_rag: boolean;
  tool: string;  // 本轮用过的工具名(非空即一直显示 "UsingTools: <tool>",回答结束也保留)
  // 本轮每一次工具调用的明细(按顺序);MessageBubble 据此渲染「每个调用一个按钮、点开看结果」。
  toolCalls: ToolCallRecord[];
  createdAt: number;  // 消息出现时间(epoch 毫秒),仅前端展示用,不落库
  // 本轮是否已结束(turn_end 已到)。agent 泡由 startTurn 建时为 false、endTurn 置 true;
  // 用户泡 / 历史泡 / 错误泡天然已落定 = true。用来判断末尾是不是「正在进行中的 agent」,
  // 进而决定尾部「思考中」该不该显示(见 shouldShowTailThinking)。
  turnEnded: boolean;
}

/**
 * 尾部「思考中」气泡是否显示(纯函数,便于单测)。
 *
 * 规则:讨论进行中(busy),且末尾不是「正在进行中的 agent 气泡」时才显示——
 *   - 末尾是用户消息 / 本轮已结束的 agent:处于「等下一个 agent 开口」的间隙,显示思考中;
 *   - 末尾是 turn_start 已建、turn_end 未到的 agent 气泡:无论它还没吐字(空泡自己显示流动点)
 *     还是正在流式输出(有字),都不再叠加尾部「思考中」。
 *
 * 关键:不能只看 last.text 是否为空——agent 正在流式输出时 text 也 >0,
 * 必须靠 turnEnded 区分「正在输出」和「上一轮已结束、等下一轮」。
 */
export function shouldShowTailThinking(busy: boolean, bubbles: Bubble[]): boolean {
  if (!busy) {
    return false;
  }
  if (bubbles.length === 0) {
    return true;
  }
  const last = bubbles[bubbles.length - 1];
  if (!last.isUser && !last.turnEnded) {
    return false;
  }
  return true;
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
  tool_calls?: ToolCallRecord[];  // DB 里这条消息的工具调用明细(jsonb);旧消息可能没有
  created_at?: string;  // DB 里这条消息的写入时间;历史气泡用它显示真实发送时间
}

/** 会议结束整理弹窗的状态(每会话一份)。 */
export interface SummaryState {
  open: boolean;
  status: "summarizing" | "done" | "error";
  message: string;
  detail: string;
}

/** 关闭态的整理弹窗默认值(getter 在该会话从未结束过时返回它)。 */
const CLOSED_SUMMARY: SummaryState = { open: false, status: "summarizing", message: "", detail: "" };

/** 一个挂起的工具审批(每会话至多一个);由 SSE 的 tool_approval_request 事件驱动。 */
export interface PendingApproval {
  turnId: string;
  approvalId: string;
  tool: string;
  risk: string;
}

interface ChatState {
  bubblesBySession: Record<string, Bubble[]>;
  busyBySession: Record<string, boolean>;
  // 已结束的会话(点「结束」后置位);纯前端内存,刷新/重启重置。
  endedBySession: Record<string, boolean>;
  // 各会话的「会议纪要整理」弹窗状态;由 SSE 的 summary_* 事件驱动(全局订阅,见 App.vue)。
  summaryBySession: Record<string, SummaryState>;
  // 各会话挂起的工具审批;有值时输入框上方弹审批条,用户拍板后清除。
  pendingApprovalBySession: Record<string, PendingApproval | null>;
}

export const useChatStore = defineStore("chat", {
  state: (): ChatState => ({
    bubblesBySession: {},
    busyBySession: {},
    endedBySession: {},
    summaryBySession: {},
    pendingApprovalBySession: {},
  }),
  getters: {
    bubblesOf: (state) => (sessionId: string) => state.bubblesBySession[sessionId] ?? [],
    isBusy: (state) => (sessionId: string) => state.busyBySession[sessionId] ?? false,
    isEnded: (state) => (sessionId: string) => state.endedBySession[sessionId] ?? false,
    summaryOf: (state) => (sessionId: string) => state.summaryBySession[sessionId] ?? CLOSED_SUMMARY,
    pendingApprovalOf: (state) => (sessionId: string) => state.pendingApprovalBySession[sessionId] ?? null,
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
        toolCalls: [],
        createdAt: Date.now(),
        turnEnded: true,  // 用户泡不参与流式,天然落定
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
        toolCalls: [],
        createdAt: Date.now(),
        turnEnded: false,  // 本轮刚开始(turn_start),turn_end 到来前一直算进行中
      });
    },
    /** 某次工具调用执行完成：把它的明细(name/args/result)追加到对应气泡，前端据此加按钮 + 展开结果。 */
    addToolCall(sessionId: string, turnId: string, rec: ToolCallRecord): void {
      const bubbles = this.bubblesBySession[sessionId] ?? [];
      for (let i = bubbles.length - 1; i >= 0; i--) {
        if (bubbles[i].turnId === turnId) {
          bubbles[i].toolCalls.push(rec);
          return;
        }
      }
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
          bubbles[i].turnEnded = true;  // 本轮收尾,末尾不再算「正在进行中的 agent」
          return;
        }
      }
    },
    /** 收到 tool_approval_request:登记本会话挂起的工具审批,输入框上方据此弹审批条。 */
    setPendingApproval(sessionId: string, p: PendingApproval): void {
      this.pendingApprovalBySession[sessionId] = p;
    },
    /** 用户已拍板(或本轮结束/打断):清掉本会话的挂起审批,审批条消失。 */
    clearPendingApproval(sessionId: string): void {
      this.pendingApprovalBySession[sessionId] = null;
    },
    finishRound(sessionId: string): void {
      this.busyBySession[sessionId] = false;
      // 本轮结束/打断:清掉可能残留的挂起审批,审批条不该跨轮存在。
      this.pendingApprovalBySession[sessionId] = null;
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
          toolCalls: t.tool_calls ?? [],
          createdAt,
          turnEnded: true,  // 历史泡都是已落定的消息
        });
      }
      this.bubblesBySession[sessionId] = bubbles;
    },
    /** 标记某会话已结束(点「结束」后);之后该会话的发送/结束会被拦截。后端会持久化,启动时由 hydrateEnded 回灌。 */
    markEnded(sessionId: string): void {
      this.endedBySession[sessionId] = true;
    },
    /** 启动时用后端会话列表回灌「已结束」状态,恢复持久化的会议锁定(刷新/重启后仍锁定)。 */
    hydrateEnded(metas: { id: string; ended?: boolean }[]): void {
      for (const m of metas) {
        if (m.ended) {
          this.endedBySession[m.id] = true;
        }
      }
    },
    /** 点「结束会议」后打开整理弹窗,进入「整理中」。 */
    openSummary(sessionId: string): void {
      this.summaryBySession[sessionId] = {
        open: true,
        status: "summarizing",
        message: "当前会议已结束,正在整理会议纪要",
        detail: "",
      };
    },
    /** 收到 summary_done:整理完成,detail 放生成的文件路径。 */
    setSummaryDone(sessionId: string, file: string): void {
      this.summaryBySession[sessionId] = {
        open: true,
        status: "done",
        message: "会议纪要已生成",
        detail: file,
      };
    },
    /** 收到 summary_error(或 chat.end 调用本身失败):整理出错。 */
    setSummaryError(sessionId: string, message: string): void {
      this.summaryBySession[sessionId] = {
        open: true,
        status: "error",
        message,
        detail: "",
      };
    },
    /** 关闭整理弹窗。 */
    closeSummary(sessionId: string): void {
      const cur = this.summaryBySession[sessionId];
      if (cur) {
        cur.open = false;
      }
    },
    /** 丢弃某会话的本地气泡(删除会话时调)。 */
    drop(sessionId: string): void {
      delete this.bubblesBySession[sessionId];
      delete this.busyBySession[sessionId];
      delete this.endedBySession[sessionId];
      delete this.summaryBySession[sessionId];
      delete this.pendingApprovalBySession[sessionId];
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
        toolCalls: [],
        createdAt: Date.now(),
        turnEnded: true,  // 错误泡是终态,不再流式
      });
      this.busyBySession[sessionId] = false;
    },
  },
});
