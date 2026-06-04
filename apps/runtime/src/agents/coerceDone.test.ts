import { describe, it, expect } from "vitest";

import { coerceDone } from "./base.js";

describe("coerceDone", () => {
  it("后端把 done 当 JSON 布尔返回时不报错(true)", () => {
    // 旧代码 output.done.trim() 在这里抛 "trim is not a function"
    expect(coerceDone(true)).toBe(true);
  });

  it("后端把 done 当 JSON 布尔返回时不报错(false)", () => {
    expect(coerceDone(false)).toBe(false);
  });

  it("字符串 'true' / 'yes' / '完成' 等视为真", () => {
    expect(coerceDone("true")).toBe(true);
    expect(coerceDone(" YES ")).toBe(true);
    expect(coerceDone("完成")).toBe(true);
  });

  it("字符串 'false' / 其他视为假", () => {
    expect(coerceDone("false")).toBe(false);
    expect(coerceDone("nope")).toBe(false);
  });
});
