import { describe, it, expect, vi } from "vitest";

// intent_node 间接读 getSettings（logger 的 logLevel）；mock 成固定值，不读 .env。
// 本测试只覆盖「规则短路」分支——这些分支在调用 NLI 之前就 return，不会加载本地模型。
vi.mock("../../config/settings.js", () => ({
  getSettings: () => ({ logLevel: "INFO" }),
}));

import { createIntentNode, matchTeamKeywordRule } from "../preprocess/intentNode.js";
import type { AgentState } from "../state.js";

function makeState(rewritten: string): AgentState {
  return { rewritten_query: rewritten, requirement: "" } as AgentState;
}

describe("matchTeamKeywordRule（开发关键词包含匹配）", () => {
  it("含开发关键词 → true", () => {
    expect(matchTeamKeywordRule("帮我设计登录架构")).toBe(true);
    expect(matchTeamKeywordRule("这个前端页面怎么写")).toBe(true);
    expect(matchTeamKeywordRule("测试一下")).toBe(true);
    expect(matchTeamKeywordRule("项目")).toBe(true);
  });

  it("不含任何开发关键词 → false", () => {
    expect(matchTeamKeywordRule("今天天气真好")).toBe(false);
    expect(matchTeamKeywordRule("你好啊")).toBe(false);
  });
});

describe("createIntentNode（开发关键词短路）", () => {
  const intentNode = createIntentNode();

  it("含开发关键词 → 短路判「开发需求」+ 满间距（强制走 team）", async () => {
    const result = await intentNode(makeState("帮我搭一个后端服务"));
    expect(result).toEqual({ intent: "开发需求", intent_score: 1, intent_margin: 1 });
  });

  it("纯问候 → 仍短路判「闲聊」（关键词规则不抢闸）", async () => {
    const result = await intentNode(makeState("你好"));
    expect(result).toEqual({ intent: "闲聊", intent_score: 1, intent_margin: 1 });
  });
});
