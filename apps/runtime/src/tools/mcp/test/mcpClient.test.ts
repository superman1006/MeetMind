import { describe, it, expect } from "vitest";

import { mcpResultToText } from "../mcpClient.js";

describe("mcpResultToText", () => {
  it("字符串结果把换行换成空格", () => {
    expect(mcpResultToText("a\nb\n\nc\n")).toBe("a b  c ");
  });

  it("换完后不残留任何换行字符", () => {
    const out = mcpResultToText("第一行\n第二行\r\n第三行");
    expect(out).not.toContain("\n");
  });

  it("非字符串结果先 JSON 序列化再当文本处理", () => {
    expect(mcpResultToText({ x: 1 })).toBe('{"x":1}');
  });
});
