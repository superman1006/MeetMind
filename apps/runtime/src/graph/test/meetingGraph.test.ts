import { END } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { classifyMeetingRule, teamRouter } from "../meetingGraph.js";

describe("数字人会议", () => {
  it("区分问候、全员点名和带有问候语的协作任务", () => {
    expect(classifyMeetingRule("你好，你是谁？")).toBe("direct");
    expect(classifyMeetingRule("每个人说一个 1")).toBe("everyone");
    expect(classifyMeetingRule("你好，分析一下项目")).toBe("task");
    expect(classifyMeetingRule("这两个模块各自负责什么？")).toBeNull();
  });

  it("按计划顺序执行，完成后结束本轮", () => {
    const steps = [
      { agentName: "u7", instruction: "说一个 1" },
      { agentName: "frontend", instruction: "说一个 1" },
    ];

    expect(teamRouter(steps, 0)).toBe("u7_node");
    expect(teamRouter(steps, 1)).toBe("frontend_node");
    expect(teamRouter(steps, 2)).toBe(END);
  });
});
