/**
 * web_fetch 工具：抓取给定 URL 的网页内容，HTML 简单转成纯文本后返回。
 *
 * 仿照 claude-code 的 WebFetchTool，但只做 MVP 最小实现——**不做鉴权、不查域名黑名单、
 * 不跟重定向之外的安全策略、不调二级模型做摘要**：fetch 拿到响应 → 是 HTML 就剥成纯文本
 * → 超长截断 → 返回。和 agent 无关（搜公网、不分角色），普通单例，所有 agent 共用。
 *
 * 走 Node 20 内置的全局 `fetch`（不引第三方 HTTP 库），用 `AbortSignal.timeout` 防止
 * 慢响应把工具循环卡死。失败时**返回提示字符串而不抛错**，和 echo / read_file 等工具一致，
 * 不打断 BaseAgent 的 Phase 1 工具循环。
 */

import {tool} from "@langchain/core/tools";
import {z} from "zod";

// 单次返回给 LLM 的最大字符数，超出截断（和 readFileTool 取同一量级）
const _MAX_CHARS = 20000;
// 抓取超时，避免慢 / 不响应的服务器把工具循环挂住
const _TIMEOUT_MS = 15000;

// 最常见的几个 HTML 实体，剥标签后顺手解码，正文更干净
const _HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** 解码上面登记的常见 HTML 实体；逐个替换，不追求覆盖全部实体。 */
function decodeEntities(text: string): string {
  let result = text;
  for (const [entity, char] of Object.entries(_HTML_ENTITIES)) {
    result = result.replaceAll(entity, char);
  }
  return result;
}

/**
 * 把 HTML 粗暴转成纯文本：去掉 script/style/注释整块 → 块级标签换行 → 剥掉剩余标签
 * → 解码实体 → 折叠多余空白。每一步结果都用具名变量存着，不做链式 replace。
 */
export function htmlToText(html: string): string {
  // <script> / <style> 整块（连内容）对正文无意义，先整段删掉
  const withoutScript = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const withoutStyle = withoutScript.replace(/<style[\s\S]*?<\/style>/gi, " ");
  // HTML 注释
  const withoutComments = withoutStyle.replace(/<!--[\s\S]*?-->/g, " ");
  // 块级结束标签换成换行，保留一点段落结构
  const withBreaks = withoutComments.replace(
    /<\/(p|div|br|li|h[1-6]|tr|section|article)>/gi,
    "\n",
  );
  // 剥掉剩余所有标签
  const withoutTags = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(withoutTags);
  // 折叠水平空白 + 连续空行
  const collapsedSpaces = decoded.replace(/[ \t]+/g, " ");
  // 剥标签时每个标签位被换成了空格，"空行"其实是只含一个空格的行(\n \n)，
  // 会让下面的连续空行折叠(\n{3,})失效——正文被一大片空行顶到下面，前端看着像"只返回了标题"。
  // 先把贴着换行的水平空白吃掉，空行才真正变空，后续折叠才生效。
  const trimmedLines = collapsedSpaces.replace(/ *\n */g, "\n");
  const collapsedNewlines = trimmedLines.replace(/\n{3,}/g, "\n\n");
  return collapsedNewlines.trim();
}

export const webFetchTool = tool(
  async ({ url }: { url: string }):Promise<String> => {
    try {
      const response = await fetch(url, {
        // AbortSignal.timeout 是 Node 20 内置的 API，fetch 超时后会自动抛错，catch 里返回提示字符串
        signal: AbortSignal.timeout(_TIMEOUT_MS),
        headers: { "User-Agent": "MeetMind-web-fetch/0.1" },
      });
      if (!response.ok) {
        return `(抓取网页失败: HTTP ${response.status} ${response.statusText})`;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const raw = await response.text();

      // HTML 剥成纯文本；其余（纯文本 / JSON / markdown 等）直接用原文
      let text: string;
      if (contentType.includes("text/html")) {
        text = htmlToText(raw);
      } else {
        text = raw;
      }
      // 把所有换行换成空格：结果在前端工具面板里是紧凑的一整段、又不会让相邻行的词粘连（和 web_search 一致）
      const flat = text.replace(/\n/g, " ");

      if (flat.length > _MAX_CHARS) {
        const head = flat.slice(0, _MAX_CHARS);
        return `${head} (网页内容过长，已截断，仅显示前 ${_MAX_CHARS} 个字符)`;
      }
      return flat;
    } catch (exc) {
      // URL 非法、超时、网络错误都走这里，返回提示而不抛，保证工具循环不断
      return `(抓取网页失败: ${String(exc)})`;
    }
  },
  {
    name: "web_fetch",
    description:
      "抓取给定 URL 的网页内容并返回正文（HTML 会被简单转成纯文本）。" +
      "当你需要查阅公网上某个具体网页 / 文档 / API 返回的内容时调用。" +
      "参数 url：要抓取的完整网址（需带 http:// 或 https:// 前缀）。" +
      `内容超过 ${_MAX_CHARS} 个字符会被截断。`,
    // 会向公网任意 URL 发请求（SSRF / 信息外泄面），风险中等
    metadata: { risk: "medium" },
    schema: z.object({
      url: z.string().describe("要抓取的完整网址，需带 http:// 或 https:// 前缀"),
    }),
  },
);
