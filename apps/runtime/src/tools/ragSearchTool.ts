/**
 * RAG 检索工具：查 agent 自己的私有知识库（工作日志 / 代码片段 / 设计文档）。
 *
 * 工具是个普通单例（所有 agent 共用同一个 `ragSearchTool`）；它要查哪个 agent 的私有表，
 * 由调用方在 invoke 时通过 RunnableConfig 的 `configurable.agentName` 传进来——
 * BaseAgent 执行工具时会带上自己的名字。这样工具本身保持无状态、可直接 bindTools。
 */

import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

import { getRetriever, type RetrievedDoc } from "../database/rag_retriever.js";
import { ARCHITECT } from "../config/constants.js";

/** 把单条 RetrievedDoc 渲染成 LLM 友好的一行：- [type / date] content。 */
function asContextLine(doc: RetrievedDoc): string {
  const tag = (doc.metadata?.type as string | undefined) ?? "note";
  const date = (doc.metadata?.date as string | undefined) ?? "";
  if (date) {
    return `- [${tag} / ${date}] ${doc.content}`;
  }
  return `- [${tag}] ${doc.content}`;
}

const description =
  "检索你自己的私有知识库（工作日志 / 代码片段 / 设计文档）。" +
  "当你认为当前问题可能与历史经验、既有约定、过往实现相关时调用本工具；" +
  "若问题与本角色的历史经验无关，可不调用。" +
  "参数 query：自然语言查询字符串。";

export const ragSearchTool = tool(
  async ({ query }: { query: string }, config?: RunnableConfig) => {
    // 调用方（BaseAgent）通过 config 传入自己的 agent 名；缺省兜底到 architect
    const agentName =
      (config?.configurable?.agentName as string | undefined) ?? ARCHITECT;
    const retriever = getRetriever(agentName);

    const docs = await retriever.retrieve(query);
    if (docs.length === 0) {
      return "(知识库中未找到相关条目)";
    }
    const lines: string[] = [];
    for (const d of docs) {
      lines.push(asContextLine(d));
    }
    return lines.join("\n");
  },
  {
    name: "rag_search",
    description,
    schema: z.object({
      query: z.string().describe("自然语言查询字符串"),
    }),
  },
);
