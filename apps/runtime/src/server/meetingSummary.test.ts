import { describe, it, expect } from "vitest";
import { formatTranscript, composeSummaryMarkdown } from "./meetingSummary.js";
import type { AgentResponse } from "../agents/base.js";

describe("formatTranscript", () => {
  it("空数组返回空串", () => {
    expect(formatTranscript([])).toBe("");
  });

  it("把每条消息拼成【role】(agent)\\n正文，段间空行", () => {
    const messages: AgentResponse[] = [
      { agent_name: "user", role: "用户", message: "做个登录页", next_agent: "architect", done: false, used_rag: false },
      { agent_name: "architect", role: "架构师（项目老大）", message: "拆解如下", next_agent: "frontend", done: false, used_rag: false },
    ];
    const text = formatTranscript(messages);
    expect(text).toContain("【用户】(user)\n做个登录页");
    expect(text).toContain("【架构师（项目老大）】(architect)\n拆解如下");
    expect(text).toContain("\n\n");
  });
});

describe("composeSummaryMarkdown", () => {
  it("组装出带纪要 + 5 段工作的整份 markdown", () => {
    const works = [
      { role: "架构师 (Architect / Tech Lead)", body: "统筹与收尾" },
      { role: "后端工程师 (Backend Engineer)", body: "设计登录接口" },
      { role: "前端工程师 (Frontend Engineer)", body: "实现登录页" },
      { role: "测试工程师 (QA Engineer)", body: "无" },
      { role: "产品经理 (Product Manager)", body: "无" },
    ];
    const md = composeSummaryMarkdown("sess-123", "用户要求做登录功能。", works, "2026-06-03T10:00:00.000Z");
    expect(md).toContain("# 会议纪要");
    expect(md).toContain("> 会议 ID: sess-123");
    expect(md).toContain("> 生成时间: 2026-06-03T10:00:00.000Z");
    expect(md).toContain("## 一、会议纪要");
    expect(md).toContain("用户要求做登录功能。");
    expect(md).toContain("## 二、各 Agent 的工作");
    expect(md).toContain("### 后端工程师 (Backend Engineer)");
    expect(md).toContain("设计登录接口");
    expect(md).toContain("### 测试工程师 (QA Engineer)");
    const qaIndex = md.indexOf("### 测试工程师 (QA Engineer)");
    expect(md.slice(qaIndex)).toContain("无");
  });
});
