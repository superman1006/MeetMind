import { describe, it, expect } from "vitest";

import { agentColor } from "../agentColors.js";

describe("agentColor", () => {
  it("已知 agent 返回各自配色与中文标签", () => {
    expect(agentColor("user").label).toBe("用户");
    expect(agentColor("architect").label).toBe("架构师");
    for (const name of ["backend", "frontend", "tester", "pm"]) {
      const c = agentColor(name);
      expect(typeof c.bg).toBe("string");
      expect(typeof c.fg).toBe("string");
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it("未知 agent → fallback 配色(标签『未知』)", () => {
    const c = agentColor("nobody");
    expect(c.label).toBe("未知");
    expect(c.bg).toBe("#f3f4f6");
  });
});
