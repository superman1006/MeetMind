import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

// agent 回复带 ## 标题、列表、**粗体**、代码块等 Markdown 语法,这里统一渲染成 HTML。
// breaks:true —— 单个换行也渲染成 <br>,贴合原来气泡 pre-wrap 的观感(agent 经常用裸换行分段)。
// linkify:true —— 裸 URL 自动变链接。html:false —— 不解析正文里的原始 HTML 标签(直接转义),
// 这是第一道 XSS 防线:LLM 吐出的 <script>/<img onerror> 会被转义成纯文本而非真标签。
const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
});

/**
 * 纯转换:Markdown 文本 → HTML 字符串(未净化)。确定性、与运行环境无关,便于单测。
 * html:false 已把正文里的原始 HTML 转义,markdown-it 自带的 validateLink 也会拦 javascript:/vbscript: 链接。
 */
export function markdownToHtml(text: string): string {
  return md.render(text);
}

/**
 * 供 v-html 使用的「已净化」HTML。在 markdownToHtml 之上再过一遍 DOMPurify 做纵深防御
 * (正文来自 LLM,属不可信输入)。DOMPurify 依赖浏览器 DOM,运行在真实浏览器 / Tauri 内核里;
 * 测试用的 happy-dom DOM 不完整,无法忠实跑 DOMPurify,故净化效果在浏览器里用 Playwright 验。
 */
export function renderMarkdown(text: string): string {
  const rawHtml = markdownToHtml(text);
  const safeHtml = DOMPurify.sanitize(rawHtml);
  return safeHtml;
}
