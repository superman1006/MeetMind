/**
 * Web 搜索工具：把百度 AI Search 的 MCP 服务（SSE 传输）包成一个 LangChain Tool，
 * 供 LLM 用 function-calling 按需联网检索实时信息。
 *
 * 这个工具**和 agent 无关**（联网搜公网，不分角色 / 不查私有表），是个普通单例，
 * 底层 MCP 连接也做成模块级懒加载单例，所有 agent 共用同一条连接。工具名 `web_search`。
 *
 * 上游 MCP 暴露的工具名是 `AIsearch`，必填参数只有 `query`（自然语言查询字符串），
 * 其余 model / temperature 等参数留默认即可（默认不过大模型，直接返回原始搜索结果）。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { getSettings } from "../config/settings.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("tools.web_search");

/** 上游百度 MCP 暴露的搜索工具名。 */
const REMOTE_TOOL_NAME = "AIsearch";

// 模块级懒加载单例：首次调用时才连 MCP，连上后复用同一条连接。
// 用「正在连接的 Promise」缓存，避免并发首调时重复建连。
let _clientPromise: Promise<Client> | null = null;

/** 拼出带 api_key 的完整 MCP SSE 端点。 */
function buildEndpoint(): string {
  const settings = getSettings();
  const baseUrl = settings.baiduSearchMcpUrl;
  const apiKey = settings.baiduSearchApiKey;
  return `${baseUrl}?api_key=${apiKey}`;
}

/** 建立到百度 AI Search MCP 的 SSE 连接，返回已 initialize 完成的 Client。 */
async function connect(): Promise<Client> {
  const endpoint = buildEndpoint();
  const transport = new SSEClientTransport(new URL(endpoint));
  const client = new Client(
    { name: "meetmind", version: "0.2.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  logger.info("已连接百度 AI Search MCP");
  return client;
}

/** 拿到（必要时新建）MCP 连接；失败时把缓存清空，下次调用可重连。 */
async function getClient(): Promise<Client> {
  if (_clientPromise === null) {
    _clientPromise = connect();
  }
  try {
    return await _clientPromise;
  } catch (exc) {
    _clientPromise = null; // 连接失败不要把坏 Promise 缓存住
    throw exc;
  }
}

/** 把 MCP callTool 的返回（content 块数组）抽成纯文本。 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text"
    ) {
      const text = (block as { text?: string }).text ?? "";
      parts.push(text);
    }
  }
  return parts.join("\n");
}

export const webSearchTool = tool(
  async ({ query }: { query: string }) => {
    const settings = getSettings();
    if (!settings.baiduSearchApiKey) {
      return "(web_search 未配置：缺少 BAIDU_SEARCH_API_KEY)";
    }
    try {
      const client = await getClient();
      const result = await client.callTool({
        name: REMOTE_TOOL_NAME,
        arguments: { query },
      });
      const text = extractText(result.content);
      if (!text) {
        return "(联网搜索未返回有效结果)";
      }
      return text;
    } catch (exc) {
      logger.warning(`联网搜索失败: ${String(exc)}`);
      return `(联网搜索失败: ${String(exc)})`;
    }
  },
  {
    name: "web_search",
    description: "联网搜索公网实时信息（新闻、文档、资料等），底层走百度 AI Search。",
    schema: z.object({
      query: z.string().describe("自然语言查询字符串"),
    }),
  },
);
