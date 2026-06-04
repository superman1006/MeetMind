/**
 * MCP 工具接入：用 @langchain/mcp-adapters 的 MultiServerMCPClient 连接外部 MCP 服务，
 * 把它们暴露的工具自动转成 LangChain 工具，登记进全局 `toolRegister`。
 *
 */

import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

import { getSettings } from "../../config/settings.js";
import { getLogger } from "../../utils/logger.js";
import { toolRegister } from "../toolRegister.js";

const logger = getLogger("tools.mcp");

// 模块级持有 client 单例：工具被调用时要走这条连接，所以**不能 close**，close 了工具就调不动了。
let _client: MultiServerMCPClient | null = null;
let _initialized = false;

// ---------------- JSON Schema → zod 的最小转换（覆盖 MCP 工具常见的扁平入参） ----------------

/** 把 JSON Schema 里单个属性节点转成对应的 zod 类型；不认识的类型回退 z.any()。 */
function jsonSchemaPropToZod(prop: unknown): z.ZodTypeAny {
  if (!prop || typeof prop !== "object") {
    return z.any();
  }
  const node = prop as Record<string, unknown>;

  // type 可能是字符串，也可能是 ["string","null"] 这种数组；取第一个非 null 的
  let typeName: string | undefined = undefined;
  if (typeof node.type === "string") {
    typeName = node.type;
  } else if (Array.isArray(node.type)) {
    for (const t of node.type) {
      if (typeof t === "string" && t !== "null") {
        typeName = t;
        break;
      }
    }
  }

  if (typeName === "string") {
    return z.string();
  }
  if (typeName === "number" || typeName === "integer") {
    return z.number();
  }
  if (typeName === "boolean") {
    return z.boolean();
  }
  if (typeName === "array") {
    const itemZod = jsonSchemaPropToZod(node.items);
    return z.array(itemZod);
  }
  if (typeName === "object") {
    return jsonSchemaObjectToZod(node);
  }
  return z.any();
}

/** 把一个 object 型 JSON Schema（带 properties / required）转成 z.object({...})。 */
function jsonSchemaObjectToZod(schema: Record<string, unknown>): z.ZodObject<z.ZodRawShape> {
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  const requiredList: string[] = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];

  const shape: z.ZodRawShape = {};
  for (const key of Object.keys(properties)) {
    const propNode = properties[key] as Record<string, unknown> | undefined;
    let zodType = jsonSchemaPropToZod(propNode);

    const description = propNode?.description;
    if (typeof description === "string" && description.length > 0) {
      zodType = zodType.describe(description);
    }

    // 非必填字段：用 nullable + optional，避免 OpenAI 兼容后端报「optional 没配 nullable」
    if (!requiredList.includes(key)) {
      zodType = zodType.nullable().optional();
    }
    shape[key] = zodType;
  }
  return z.object(shape);
}

/**
 * 把 MCP 工具返回值收敛成纯文本，并把所有换行换成空格。
 * web 搜索（AIsearch）的结果带大量 \n，落进前端工具结果面板里会被一堆空行撑散、
 * 正文被顶到下面（和 web_fetch 之前的毛病同源）；这里把换行全换成空格，既紧凑又不让词粘连。
 */
export function mcpResultToText(out: unknown): string {
  let text: string;
  if (typeof out === "string") {
    text = out;
  } else {
    text = JSON.stringify(out);
  }
  const flattened = text.replace(/\n/g, " ");
  return flattened;
}

/**
 * LangChain 要求工具的 schema 是 zod schema，所以需要将 MCP 工具的 schema 转换为 zod schema
 */
function wrapMcpToolWithZod(mcpTool: StructuredToolInterface): StructuredToolInterface {
  // 获取 MCP 工具的 schema
  const rawSchema = (mcpTool as unknown as { schema?: unknown }).schema;
  // 如果 schema 是 zod schema，则直接返回原工具
  const isZodSchema =
    !!rawSchema &&
    typeof rawSchema === "object" &&
    "_def" in (rawSchema as Record<string, unknown>);
  // 如果 schema 不是 zod schema，则转换为 zod schema
  if (isZodSchema) {
    return mcpTool;
  }

  const zodSchema = jsonSchemaObjectToZod((rawSchema ?? {}) as Record<string, unknown>);
  const wrapped = tool(
    async (input: Record<string, unknown>, config?: RunnableConfig) => {
      // 委托给原始 MCP 工具执行（保留真正的远程 MCP 调用）
      const out = await mcpTool.invoke(input, config);
      // 转成纯文本并删掉所有换行（web 搜索结果 \n 很多，前端面板里看着散）
      const text = mcpResultToText(out);
      return text;
    },
    {
      name: mcpTool.name,
      description: mcpTool.description ?? "",
      schema: zodSchema,
    },
  );
  return wrapped;
}

// ---------------------------------- 初始化入口 ----------------------------------

/**
 * 连接所有已配置的 MCP 服务、把它们的工具登记进全局 toolRegister。
 * 返回登记的工具数。幂等：重复调用只生效一次。没配 key / 连接失败时静默跳过（返回 0、不抛错）。
 */
export async function initMcpTools(): Promise<number> {
  // 如果已经初始化过了，直接返回 0
  if (_initialized) {
    return 0;
  }
  _initialized = true;

  // 获取配置
  const settings = getSettings();
  // 如果未配置 BAIDU_SEARCH_API_KEY 则跳过
  if (!settings.baiduSearchApiKey) {
    logger.warning(
      "未配置 BAIDU_SEARCH_API_KEY，跳过 MCP 工具加载（web 搜索将不可用）",
    );
    return 0;
  }

  // 百度 AI Search 的 MCP 走 SSE，api_key 拼在 url 查询串里（端点必须用 https）
  const endpoint = `${settings.baiduSearchMcpUrl}?api_key=${settings.baiduSearchApiKey}`;
  _client = new MultiServerMCPClient({
    // 单个工具加载失败不抛错，能加载到几个算几个（连接失败由下方 try/catch 兜底）
    throwOnLoadError: false,
    // 不给工具名加任何前缀，保持上游原名（这样 LLM / 前端看到的就是 AIsearch）
    prefixToolNameWithServerName: false,
    additionalToolNamePrefix: "",
    // 配置 MCP 服务器
    mcpServers: {
      baidu_search: {
        // transport 是传输协议,可选值有 sse、http,其中的 http 默认支持 stream 流式传输
        transport: "sse",
        url: endpoint,
      },
    },
  });

  try {
    //使用 MultiServerMCPClient 的 getTools 方法获取当前已配置的 MCP 的所有工具
    const mcpTools = await _client.getTools();
    let count = 0;
    for (const mcpTool of mcpTools) {
      // 关键：MCP 工具 schema 是 JSON Schema，bindTools 之前先转成 zod schema 工具
      const zodTool = wrapMcpToolWithZod(mcpTool);
      // 将工具登记到工具注册表
      toolRegister.register(zodTool);
      logger.info(`已登记 MCP 工具: ${zodTool.name}`);
      count++;
    }
    logger.info(`MCP 工具加载完成，共 ${count} 个`);
    return count;
  } catch (exc) {
    logger.warning(`MCP 工具加载失败（已跳过，不影响启动）: ${String(exc)}`);
    return 0;
  }
}
