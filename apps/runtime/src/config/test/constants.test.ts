import { describe, it, expect } from "vitest";

import {
  AGENT_NAMES,
  NON_ARCHITECT_AGENTS,
  ROLE_DESCRIPTIONS,
  isAgentName,
  ARCHITECT,
} from "../constants.js";

describe("config/constants", () => {
  it("AGENT_NAMES 为 5 个角色,架构师在首位", () => {
    expect(AGENT_NAMES).toEqual(["architect", "backend", "frontend", "tester", "pm"]);
    expect(AGENT_NAMES[0]).toBe(ARCHITECT);
  });

  it("NON_ARCHITECT_AGENTS 是除架构师外的 4 个", () => {
    expect(NON_ARCHITECT_AGENTS).toEqual(["backend", "frontend", "tester", "pm"]);
    expect(NON_ARCHITECT_AGENTS).not.toContain(ARCHITECT);
  });

  it("ROLE_DESCRIPTIONS 给每个 agent 都配了非空中文描述", () => {
    for (const name of AGENT_NAMES) {
      expect(typeof ROLE_DESCRIPTIONS[name]).toBe("string");
      expect(ROLE_DESCRIPTIONS[name].length).toBeGreaterThan(0);
    }
  });

  it("isAgentName:合法 agent 名 → true", () => {
    for (const name of AGENT_NAMES) {
      expect(isAgentName(name)).toBe(true);
    }
  });

  it("isAgentName:非法名(空串/大小写/陌生词)→ false", () => {
    for (const bad of ["", "Architect", "BACKEND", "boss", "user", "system"]) {
      expect(isAgentName(bad)).toBe(false);
    }
  });
});
