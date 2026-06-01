import { describe, it, expect, beforeEach } from "vitest";
import {
  getMessages,
  replaceMessages,
  resetSession,
  isBusy,
  setBusy,
} from "./sessions.js";
import type { AgentResponse } from "../agents/base.js";

function turn(message: string): AgentResponse {
  return {
    agent_name: "architect",
    role: "架构师",
    message,
    next_agent: "architect",
    done: false,
    used_rag: false,
  };
}

describe("sessions", () => {
  beforeEach(() => {
    resetSession("s1");
    setBusy("s1", false);
  });

  it("未知会话返回空数组", () => {
    expect(getMessages("nope")).toEqual([]);
  });

  it("replace 后能取回", () => {
    replaceMessages("s1", [turn("hi")]);
    expect(getMessages("s1")).toHaveLength(1);
    expect(getMessages("s1")[0].message).toBe("hi");
  });

  it("reset 清空", () => {
    replaceMessages("s1", [turn("hi")]);
    resetSession("s1");
    expect(getMessages("s1")).toEqual([]);
  });

  it("busy 标记可置位/清位", () => {
    expect(isBusy("s1")).toBe(false);
    setBusy("s1", true);
    expect(isBusy("s1")).toBe(true);
    setBusy("s1", false);
    expect(isBusy("s1")).toBe(false);
  });
});
