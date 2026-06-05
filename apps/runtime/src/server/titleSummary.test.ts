import { describe, it, expect } from "vitest";
import { cleanTitle } from "./titleSummary.js";

describe("cleanTitle", () => {
  it("去掉所有换行符(\\n / \\r)", () => {
    expect(cleanTitle("前端\n登录页")).toBe("前端登录页");
    expect(cleanTitle("做一个\r\n聊天应用")).toBe("做一个聊天应用");
  });

  it("去掉首尾空白", () => {
    expect(cleanTitle("  登录页设计  ")).toBe("登录页设计");
  });

  it("超过 15 字时兜底截断到 15 字", () => {
    const raw = "一二三四五六七八九十一二三四五六七八九十"; // 20 字
    const out = cleanTitle(raw);
    expect(out).toBe("一二三四五六七八九十一二三四五");
    expect([...out]).toHaveLength(15);
  });

  it("15 字以内原样返回", () => {
    expect(cleanTitle("用户登录与注册功能")).toBe("用户登录与注册功能");
  });

  it("空白 / 纯换行输入返回空串", () => {
    expect(cleanTitle("\n\n")).toBe("");
    expect(cleanTitle("   ")).toBe("");
  });
});
