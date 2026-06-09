import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

import { useChatStore, shouldShowTailThinking, type Bubble } from "../chat.js";

// 造一个气泡用于纯函数测试;只关心 isUser / text / turnEnded 三个字段,其余给默认值。
function mkBubble(over: Partial<Bubble>): Bubble {
  return {
    turnId: "t",
    agent_name: "backend",
    role: "后端",
    text: "",
    isUser: false,
    done: false,
    used_rag: false,
    tool: "",
    toolCalls: [],
    createdAt: 0,
    turnEnded: false,
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("chat store — 基本收发", () => {
  it("addUser 追加用户气泡并置 busy", () => {
    const chat = useChatStore();
    chat.addUser("s1", "做个登录页");
    const bubbles = chat.bubblesOf("s1");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ isUser: true, text: "做个登录页", agent_name: "user" });
    expect(chat.isBusy("s1")).toBe(true);
  });

  it("startTurn 追加空 agent 气泡(thinking 态)", () => {
    const chat = useChatStore();
    chat.startTurn("s1", "t1", "backend", "后端");
    const b = chat.bubblesOf("s1")[0];
    expect(b).toMatchObject({ turnId: "t1", agent_name: "backend", isUser: false, text: "" });
  });

  it("appendDelta 把增量拼到对应 turn", () => {
    const chat = useChatStore();
    chat.startTurn("s1", "t1", "backend", "后端");
    chat.appendDelta("s1", "t1", "你好");
    chat.appendDelta("s1", "t1", "世界");
    expect(chat.bubblesOf("s1")[0].text).toBe("你好世界");
  });

  it("useTool 去重累加工具名(相同不重复、不同用逗号接)", () => {
    const chat = useChatStore();
    chat.startTurn("s1", "t1", "backend", "后端");
    chat.useTool("s1", "t1", "rag_search");
    chat.useTool("s1", "t1", "rag_search");
    chat.useTool("s1", "t1", "web_search");
    expect(chat.bubblesOf("s1")[0].tool).toBe("rag_search, web_search");
  });

  it("endTurn 写回 used_rag", () => {
    const chat = useChatStore();
    chat.startTurn("s1", "t1", "backend", "后端");
    chat.appendDelta("s1", "t1", "内容");
    chat.endTurn("s1", "t1", true);
    expect(chat.bubblesOf("s1")[0].used_rag).toBe(true);
  });
});

describe("chat store — finishRound 清理", () => {
  it("清 busy 并弹掉末尾「空 agent 占位」气泡", () => {
    const chat = useChatStore();
    chat.addUser("s1", "需求"); // 用户泡
    chat.startTurn("s1", "t1", "backend", "后端"); // 空 agent 泡(无内容)
    chat.finishRound("s1");
    expect(chat.isBusy("s1")).toBe(false);
    const bubbles = chat.bubblesOf("s1");
    expect(bubbles).toHaveLength(1); // 空 agent 泡被弹掉,只剩用户泡
    expect(bubbles[0].isUser).toBe(true);
  });

  it("有内容的 agent 泡不被弹", () => {
    const chat = useChatStore();
    chat.startTurn("s1", "t1", "backend", "后端");
    chat.appendDelta("s1", "t1", "有内容");
    chat.finishRound("s1");
    expect(chat.bubblesOf("s1")).toHaveLength(1);
  });
});

describe("chat store — 历史 / 结束 / 丢弃", () => {
  it("load 用 StoredTurn 覆盖气泡,created_at 被解析成 epoch 毫秒", () => {
    const chat = useChatStore();
    chat.load("s1", [
      { agent_name: "user", role: "用户", message: "hi", next_agent: null, done: false, used_rag: false, tool: "", created_at: "2026-06-02T10:23:00Z" },
      { agent_name: "backend", role: "后端", message: "答", next_agent: "architect", done: false, used_rag: true, tool: "rag_search" },
    ]);
    const bubbles = chat.bubblesOf("s1");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toMatchObject({ isUser: true, text: "hi" });
    expect(bubbles[1]).toMatchObject({ isUser: false, text: "答", used_rag: true, tool: "rag_search" });
    expect(typeof bubbles[0].createdAt).toBe("number");
  });

  it("markEnded / isEnded", () => {
    const chat = useChatStore();
    expect(chat.isEnded("s1")).toBe(false);
    chat.markEnded("s1");
    expect(chat.isEnded("s1")).toBe(true);
  });

  it("hydrateEnded 从后端 metas 回灌 ended(只认 ended 为真的)", () => {
    const chat = useChatStore();
    chat.hydrateEnded([{ id: "s1", ended: true }, { id: "s2", ended: false }, { id: "s3" }]);
    expect(chat.isEnded("s1")).toBe(true);
    expect(chat.isEnded("s2")).toBe(false);
    expect(chat.isEnded("s3")).toBe(false);
  });

  it("drop 清掉某会话的气泡 / busy / ended", () => {
    const chat = useChatStore();
    chat.addUser("s1", "x");
    chat.markEnded("s1");
    chat.drop("s1");
    expect(chat.bubblesOf("s1")).toEqual([]);
    expect(chat.isBusy("s1")).toBe(false);
    expect(chat.isEnded("s1")).toBe(false);
  });

  it("addErrorBubble 追加系统错误泡并清 busy", () => {
    const chat = useChatStore();
    chat.addUser("s1", "x"); // busy = true
    chat.addErrorBubble("s1", "出错了");
    const bubbles = chat.bubblesOf("s1");
    expect(bubbles[bubbles.length - 1].text).toContain("出错了");
    expect(chat.isBusy("s1")).toBe(false);
  });
});

describe("chat store — turnEnded 标记", () => {
  it("startTurn 建的气泡 turnEnded=false,endTurn 后置 true", () => {
    const chat = useChatStore();
    chat.startTurn("s1", "t1", "backend", "后端");
    expect(chat.bubblesOf("s1")[0].turnEnded).toBe(false);
    chat.endTurn("s1", "t1", false);
    expect(chat.bubblesOf("s1")[0].turnEnded).toBe(true);
  });

  it("appendDelta 不改变 turnEnded(流式中仍是未结束)", () => {
    const chat = useChatStore();
    chat.startTurn("s1", "t1", "backend", "后端");
    chat.appendDelta("s1", "t1", "正在输出");
    expect(chat.bubblesOf("s1")[0].turnEnded).toBe(false);
  });

  it("用户泡 / 历史泡默认 turnEnded=true(已落定)", () => {
    const chat = useChatStore();
    chat.addUser("s1", "需求");
    expect(chat.bubblesOf("s1")[0].turnEnded).toBe(true);
    chat.load("s2", [
      { agent_name: "backend", role: "后端", message: "答", next_agent: "architect", done: false, used_rag: false, tool: "" },
    ]);
    expect(chat.bubblesOf("s2")[0].turnEnded).toBe(true);
  });
});

describe("chat store — 工具审批挂起状态", () => {
  it("默认无挂起审批", () => {
    const chat = useChatStore();
    expect(chat.pendingApprovalOf("s1")).toBe(null);
  });

  it("setPendingApproval 登记、clearPendingApproval 清除", () => {
    const chat = useChatStore();
    chat.setPendingApproval("s1", { turnId: "backend-1", approvalId: "backend-1-0", tool: "web_fetch", risk: "medium" });
    expect(chat.pendingApprovalOf("s1")).toMatchObject({ tool: "web_fetch", risk: "medium", approvalId: "backend-1-0" });
    chat.clearPendingApproval("s1");
    expect(chat.pendingApprovalOf("s1")).toBe(null);
  });

  it("finishRound 清掉残留的挂起审批(审批条不跨轮)", () => {
    const chat = useChatStore();
    chat.setPendingApproval("s1", { turnId: "backend-1", approvalId: "backend-1-0", tool: "web_fetch", risk: "medium" });
    chat.finishRound("s1");
    expect(chat.pendingApprovalOf("s1")).toBe(null);
  });

  it("drop 清掉某会话的挂起审批", () => {
    const chat = useChatStore();
    chat.setPendingApproval("s1", { turnId: "backend-1", approvalId: "backend-1-0", tool: "web_fetch", risk: "medium" });
    chat.drop("s1");
    expect(chat.pendingApprovalOf("s1")).toBe(null);
  });
});

describe("chat store — 断点续跑", () => {
  it("setResumable 追加崩溃前发言并置 resumable", () => {
    const chat = useChatStore();
    chat.addUser("s1", "做个登录页");
    chat.setResumable("s1", [
      { agent_name: "architect", role: "架构师", message: "我来分配", next_agent: "backend", done: false, used_rag: false, tool: "" },
    ]);
    const bubbles = chat.bubblesOf("s1");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[1]).toMatchObject({ agent_name: "architect", text: "我来分配", turnEnded: true, isUser: false });
    expect(chat.isResumable("s1")).toBe(true);
  });

  it("clearResumable 复位 resumable", () => {
    const chat = useChatStore();
    chat.setResumable("s1", [
      { agent_name: "architect", role: "架构师", message: "x", next_agent: null, done: false, used_rag: false, tool: "" },
    ]);
    chat.clearResumable("s1");
    expect(chat.isResumable("s1")).toBe(false);
  });

  it("beginResume 置 busy 且清 resumable", () => {
    const chat = useChatStore();
    chat.setResumable("s1", [
      { agent_name: "architect", role: "架构师", message: "x", next_agent: null, done: false, used_rag: false, tool: "" },
    ]);
    chat.beginResume("s1");
    expect(chat.isBusy("s1")).toBe(true);
    expect(chat.isResumable("s1")).toBe(false);
  });

  it("drop 一并清掉 resumable", () => {
    const chat = useChatStore();
    chat.setResumable("s1", [
      { agent_name: "architect", role: "架构师", message: "x", next_agent: null, done: false, used_rag: false, tool: "" },
    ]);
    chat.drop("s1");
    expect(chat.isResumable("s1")).toBe(false);
  });

  it("load 重置 resumable（避免上次提示残留到本次）", () => {
    const chat = useChatStore();
    chat.setResumable("s1", [
      { agent_name: "architect", role: "架构师", message: "x", next_agent: null, done: false, used_rag: false, tool: "" },
    ]);
    chat.load("s1", []);
    expect(chat.isResumable("s1")).toBe(false);
  });

  it("addUser 重置 resumable（发新消息=放弃崩溃轮）", () => {
    const chat = useChatStore();
    chat.setResumable("s1", [
      { agent_name: "architect", role: "架构师", message: "x", next_agent: null, done: false, used_rag: false, tool: "" },
    ]);
    chat.addUser("s1", "新需求");
    expect(chat.isResumable("s1")).toBe(false);
  });

  it("discardResumable 删掉未落库的 resume 气泡并清 resumable", () => {
    const chat = useChatStore();
    chat.addUser("s1", "做个登录页");  // 已落库的用户泡(user-0),放弃后应保留
    chat.setResumable("s1", [
      { agent_name: "architect", role: "架构师", message: "我来分配", next_agent: "backend", done: false, used_rag: false, tool: "" },
      { agent_name: "backend", role: "后端", message: "好的", next_agent: "architect", done: false, used_rag: false, tool: "" },
    ]);
    expect(chat.bubblesOf("s1")).toHaveLength(3);
    chat.discardResumable("s1");
    const bubbles = chat.bubblesOf("s1");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ turnId: "user-0", isUser: true });
    expect(chat.isResumable("s1")).toBe(false);
  });
});

describe("shouldShowTailThinking — 尾部「思考中」显示规则", () => {
  it("不 busy 时永远不显示", () => {
    expect(shouldShowTailThinking(false, [])).toBe(false);
    expect(shouldShowTailThinking(false, [mkBubble({ isUser: true, text: "x", turnEnded: true })])).toBe(false);
  });

  it("busy 且无气泡 → 显示(刚连上还没任何泡)", () => {
    expect(shouldShowTailThinking(true, [])).toBe(true);
  });

  it("用户刚发完、还没 turn_start → 显示", () => {
    const bubbles = [mkBubble({ isUser: true, text: "需求", turnEnded: true })];
    expect(shouldShowTailThinking(true, bubbles)).toBe(true);
  });

  it("上一个 agent 已结束、等下一个 turn_start(轮次间隙) → 显示", () => {
    const bubbles = [mkBubble({ isUser: false, text: "上轮回答", turnEnded: true })];
    expect(shouldShowTailThinking(true, bubbles)).toBe(true);
  });

  it("agent 已 turn_start 但还没吐字(Phase 1 思考) → 不显示(空泡自己有流动点)", () => {
    const bubbles = [mkBubble({ isUser: false, text: "", turnEnded: false })];
    expect(shouldShowTailThinking(true, bubbles)).toBe(false);
  });

  // 这条是本次 bug 的核心:agent 正在流式输出(有字、turn_end 未到)时,尾部「思考中」绝不能出现。
  it("agent 正在流式输出(有字、本轮未结束) → 不显示", () => {
    const bubbles = [mkBubble({ isUser: false, text: "正在边想边写", turnEnded: false })];
    expect(shouldShowTailThinking(true, bubbles)).toBe(false);
  });
});
