import { describe, it, expect } from "vitest";

import { coerceDone, memorySection } from "./base.js";

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

describe("memorySection", () => {
  it("空 / 纯空白记忆 → 返回空串(不加任何噪声)", () => {
    expect(memorySection("")).toBe("");
    expect(memorySection("   \n  ")).toBe("");
  });

  it("有记忆 → 带中文抬头、含记忆正文、以两个换行结尾(与角色提示词隔开)", () => {
    const out = memorySection("我喜欢简洁设计");
    expect(out).toContain("用户长期记忆");
    expect(out).toContain("我喜欢简洁设计");
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("记忆前后空白被 trim", () => {
    const out = memorySection("  保持中文注释  ");
    expect(out).toContain("保持中文注释");
    expect(out).not.toContain("  保持中文注释  ");
  });
});
