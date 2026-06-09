import { describe, it, expect, vi } from "vitest";
import { END } from "@langchain/langgraph";

// 路由依赖 getSettings().maxIterations;mock 成固定 15,让迭代上限可控、不读 .env。
// logLevel 也要给:route 间接 import 了 logger,logger 初始化时会读 getSettings().logLevel。
vi.mock("../../config/settings.js", () => ({
  getSettings: () => ({ maxIterations: 15, logLevel: "INFO" }),
}));

import { routeToWhichAgent } from "../route.js";
import type { AgentState } from "../state.js";

// 构造一个最小可用的 AgentState,只覆盖路由关心的字段。
function makeState(partial: Partial<AgentState>): AgentState {
  return {
    requirement: "",
    messages: [],
    next_agent: null,
    done: false,
    iteration: 0,
    ...partial,
  } as AgentState;
}

describe("routeToWhichAgent", () => {
  it("达到迭代上限 → END(安全阀)", () => {
    expect(routeToWhichAgent(makeState({ iteration: 15 }))).toBe(END);
    expect(routeToWhichAgent(makeState({ iteration: 99 }))).toBe(END);
  });

  it("迭代上限优先级最高(即便 next_agent 合法也强制 END)", () => {
    expect(routeToWhichAgent(makeState({ iteration: 15, next_agent: "backend" }))).toBe(END);
  });

  it("done=true → END(架构师宣布完成)", () => {
    expect(routeToWhichAgent(makeState({ done: true }))).toBe(END);
  });

  it("合法 next_agent → <name>_node", () => {
    expect(routeToWhichAgent(makeState({ next_agent: "backend" }))).toBe("backend_node");
    expect(routeToWhichAgent(makeState({ next_agent: "pm" }))).toBe("pm_node");
    expect(routeToWhichAgent(makeState({ next_agent: "architect" }))).toBe("architect_node");
  });

  it("next_agent 为 null → 兜底回 architect_node", () => {
    expect(routeToWhichAgent(makeState({ next_agent: null }))).toBe("architect_node");
  });

  it("next_agent 非法名 → 兜底回 architect_node(图永不卡死)", () => {
    expect(routeToWhichAgent(makeState({ next_agent: "nobody" }))).toBe("architect_node");
    expect(routeToWhichAgent(makeState({ next_agent: "" }))).toBe("architect_node");
  });
});
