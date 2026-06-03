import { describe, it, expect } from "vitest";

import { splitJson, splitText, splitMarkdown, splitDocs } from "./splitters.js";
import type { RawDoc } from "./loaders.js";

describe("splitJson", () => {
  it("原样透传(种子 JSON 不再切,返回同一引用)", () => {
    const docs: RawDoc[] = [
      { content: "条目一", type: "json", source: "seeds.json" },
      { content: "条目二", type: "json", source: "seeds.json" },
    ];
    expect(splitJson(docs)).toBe(docs);
  });
});

describe("splitText", () => {
  it("短文本只有一段时原样返回(source 不变)", async () => {
    const docs: RawDoc[] = [{ content: "很短的一句话", type: "txt", source: "a.txt" }];
    const out = await splitText(docs);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("很短的一句话");
    expect(out[0].source).toBe("a.txt");
  });

  it("超长文本被切成多段,每段 source 标 #chunkN", async () => {
    const long = "这是一段用于测试切块的中文文本。".repeat(80); // 远超 chunkSize=500
    const out = await splitText([{ content: long, type: "txt", source: "big.txt" }]);
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) {
      expect(typeof piece.content).toBe("string");
      expect(piece.content.length).toBeGreaterThan(0);
      expect(String(piece.source)).toContain("#chunk");
    }
    expect(out[0].source).toBe("big.txt#chunk0");
  });

  it("空白内容被跳过", async () => {
    const out = await splitText([{ content: "   ", type: "txt" }]);
    expect(out).toEqual([]);
  });
});

describe("splitMarkdown", () => {
  it("按标题/长度切,产出非空段", async () => {
    const md = "# 大标题\n\n第一段内容。\n\n## 小节\n\n第二段内容。";
    const out = await splitMarkdown([{ content: md, type: "markdown", source: "m.md" }]);
    expect(out.length).toBeGreaterThanOrEqual(1);
    for (const d of out) {
      expect(typeof d.content).toBe("string");
      expect(d.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("纯空白文档 → []", async () => {
    const out = await splitMarkdown([{ content: "   \n  ", type: "markdown" }]);
    expect(out).toEqual([]);
  });
});

describe("splitDocs(顶层按 type 分发)", () => {
  it("空数组 → []", async () => {
    expect(await splitDocs([])).toEqual([]);
  });

  it("json 类型走透传,顺序保留", async () => {
    const out = await splitDocs([
      { content: "甲", type: "json" },
      { content: "乙", type: "json" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe("甲");
    expect(out[1].content).toBe("乙");
  });

  it("未知类型兜底走 splitText", async () => {
    const out = await splitDocs([{ content: "短", type: "weird-type" }]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("短");
  });

  it("缺省 type 当 text 处理", async () => {
    const out = await splitDocs([{ content: "无类型短文" }]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("无类型短文");
  });

  it("pdf / docx 类型走各自的递归切块器", async () => {
    const long = "这是一段用于测试切块的中文文本。".repeat(80);
    const outPdf = await splitDocs([{ content: long, type: "pdf", source: "a.pdf" }]);
    expect(outPdf.length).toBeGreaterThan(1);
    const outDocx = await splitDocs([{ content: long, type: "docx", source: "a.docx" }]);
    expect(outDocx.length).toBeGreaterThan(1);
  });

  it("混合类型分别分发(json 透传 + txt 切块),都在结果里", async () => {
    const out = await splitDocs([
      { content: "J", type: "json" },
      { content: "T短", type: "txt" },
    ]);
    expect(out).toHaveLength(2);
    // 分组按 type 插入顺序:json 组在前、txt 组在后
    expect(out[0].content).toBe("J");
    expect(out[1].content).toBe("T短");
  });
});
