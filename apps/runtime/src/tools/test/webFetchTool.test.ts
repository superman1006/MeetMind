import { describe, it, expect } from "vitest";

import { htmlToText } from "../webFetchTool.js";

describe("htmlToText", () => {
  it("剥标签后不残留大片空行(空行最多 1 行,正文不被顶到下面)", () => {
    // 模拟 GitHub 这类页面:标题后跟一堆空的块级标签,剥标签会插入空格 → 形成 "\n \n \n"。
    // 旧实现里 \n{3,} 折叠被这些孤立空格破坏,正文(Hello/World)会被一大片空行顶下去。
    const emptyDivs = "<div></div>".repeat(50);
    const html =
      "<title>标题</title>" + emptyDivs + "<p>Hello</p>" + emptyDivs + "<p>World</p>";

    const text = htmlToText(html);
    const lines = text.split("\n");

    // 连续空行不应超过 1 行
    let maxConsecutiveBlank = 0;
    let current = 0;
    for (const line of lines) {
      if (line.trim() === "") {
        current += 1;
        if (current > maxConsecutiveBlank) {
          maxConsecutiveBlank = current;
        }
      } else {
        current = 0;
      }
    }
    expect(maxConsecutiveBlank).toBeLessThanOrEqual(1);

    // 正文都在,且紧跟标题(标题与 Hello 之间不超过 2 行间隔)
    expect(text).toContain("标题");
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    const titleIdx = lines.findIndex((l) => l.includes("标题"));
    const helloIdx = lines.findIndex((l) => l.includes("Hello"));
    expect(helloIdx - titleIdx).toBeLessThanOrEqual(2);
  });
});
