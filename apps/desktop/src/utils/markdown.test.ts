import { describe, it, expect } from "vitest";
import { markdownToHtml } from "./markdown.js";

// 只测确定性的 markdown-it 转换层(与运行环境无关)。净化层 DOMPurify 依赖真实浏览器 DOM,
// happy-dom 跑不忠实,放到 Playwright 端到端验。
describe("markdownToHtml", () => {
  it("## 标题渲染成 <h2>", () => {
    const html = markdownToHtml("## 标题");
    expect(html).toContain("<h2>");
    expect(html).toContain("标题");
  });

  it("**粗体** 渲染成 <strong>", () => {
    const html = markdownToHtml("这是 **重点**");
    expect(html).toContain("<strong>重点</strong>");
  });

  it("无序列表渲染成 <ul><li>", () => {
    const html = markdownToHtml("- 一\n- 二");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>一</li>");
  });

  it("代码块渲染成 <pre><code>", () => {
    const html = markdownToHtml("```\ncode\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code>");
  });

  it("单换行渲染成 <br>(breaks:true)", () => {
    const html = markdownToHtml("第一行\n第二行");
    expect(html).toContain("<br>");
  });

  it("html:false —— 正文里的原始 HTML 标签被转义成纯文本,不生成真标签(第一道 XSS 防线)", () => {
    const html = markdownToHtml("正常文字\n\n<img src=x onerror=alert(1)>");
    // 危险标签被转义:出现 &lt; 而不会出现可执行的 <img ... onerror
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });
});
