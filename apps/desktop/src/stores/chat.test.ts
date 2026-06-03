import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

import { useChatStore } from "./chat.js";

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
