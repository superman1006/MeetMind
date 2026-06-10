import { describe, it, expect, vi } from "vitest";

// route_node / routeAfterPreprocess 都间接读 getSettings（margin 阈值 + logger 的 logLevel）；
// mock 成固定值，让分流判断可控、不读 .env。
vi.mock("../../config/settings.js", () => ({
  getSettings: () => ({ maxIterations: 15, logLevel: "INFO", intentRouteMargin: 0.08 }),
}));

import { routeAfterPreprocess } from "../route.js";
import { createRouteNode } from "../preprocess/routeNode.js";
import type { AgentState } from "../state.js";

function makeState(partial: Partial<AgentState>): AgentState {
  return {
    requirement: "",
    rewritten_query: "",
    expansion_terms: "",
    intent: "",
    intent_score: 0,
    intent_margin: 0,
    route: "",
    userMemory: "",
    messages: [],
    next_agent: null,
    done: false,
    iteration: 0,
    ...partial,
  } as AgentState;
}

describe("routeAfterPreprocess（条件边纯分派）", () => {
  it("route=chat → assistant_node", () => {
    expect(routeAfterPreprocess(makeState({ route: "chat" }))).toBe("assistant_node");
  });

  it("route=team → architect_node", () => {
    expect(routeAfterPreprocess(makeState({ route: "team" }))).toBe("architect_node");
  });

  it("route 为空串 / 未知值 → 兜底回 architect_node", () => {
    expect(routeAfterPreprocess(makeState({ route: "" }))).toBe("architect_node");
    expect(routeAfterPreprocess(makeState({ route: "whatever" }))).toBe("architect_node");
  });
});

describe("createRouteNode（NLI label + margin 分流决策）", () => {
  const routeNode = createRouteNode();

  it("间距够大 + 助手意图（闲聊 / 知识问答）→ chat", async () => {
    expect(await routeNode(makeState({ intent: "闲聊", intent_margin: 0.2 }))).toEqual({ route: "chat" });
    expect(await routeNode(makeState({ intent: "知识问答", intent_margin: 0.08 }))).toEqual({ route: "chat" });
  });

  it("间距够大 + 非助手意图（开发需求 / 任务指令）→ team", async () => {
    expect(await routeNode(makeState({ intent: "开发需求", intent_margin: 0.3 }))).toEqual({ route: "team" });
    expect(await routeNode(makeState({ intent: "任务指令", intent_margin: 0.1 }))).toEqual({ route: "team" });
  });

  it("间距过小（判定不了）→ 默认走 chat，无论命中哪个意图", async () => {
    expect(await routeNode(makeState({ intent: "开发需求", intent_margin: 0.027 }))).toEqual({ route: "chat" });
    expect(await routeNode(makeState({ intent: "闲聊", intent_margin: 0.05 }))).toEqual({ route: "chat" });
  });

  it("意图为空 / 分类失败（margin=0）→ 判定不了 → chat", async () => {
    expect(await routeNode(makeState({ intent: "", intent_margin: 0 }))).toEqual({ route: "chat" });
  });
});
