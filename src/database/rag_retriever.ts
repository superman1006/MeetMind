/**
 * 每个 Agent 私有的 RAG 检索工具：PostgreSQL 混合检索 + 本地 cross-encoder rerank。
 *
 * 流程：
 *   1) 关键字召回：pg_trgm word_similarity(query, content) 拉 candidateN 候选
 *   2) 向量检索：query → embedding，pgvector cosine kNN 拉 candidateN 候选
 *   3) 合并去重：按行 id 取并集
 *   4) 本地 cross-encoder rerank
 *   5) 取 rerank 后的 top-K 给 LLM
 *
 * 用 `getTool()` 把检索器暴露成 LangChain Tool，LLM 用 function-calling 按需调用。
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { getSettings } from "../config/settings.js";
import { getLogger } from "../utils/logger.js";
import { ensureAgentTable, getPgPool } from "./client.js";
import { embed } from "./embedding.js";
import { rerank } from "./reranker.js";

const logger = getLogger("database.rag_retriever");

/**
 * 混合检索 + rerank 之后命中的单条结果。
 */
export interface RetrievedDoc {
  content: string;
  metadata: Record<string, unknown>;
  relevanceScore: number;
}

function asContextLine(doc: RetrievedDoc): string {
  const tag = (doc.metadata?.type as string | undefined) ?? "note";
  const date = (doc.metadata?.date as string | undefined) ?? "";
  if (date) {
    return `- [${tag} / ${date}] ${doc.content}`;
  }
  return `- [${tag}] ${doc.content}`;
}

interface DbRow {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number;
}

export class RAGRetriever {
  readonly agentName: string;
  // 本轮调用计数；BaseAgent 通过它判断是否要在面板上标 "调用过 RAG"
  callCount: number = 0;
  private _tableName: string | null = null;

  constructor(agentName: string) {
    this.agentName = agentName;
  }

  /**
   * 每轮 Agent.invoke() 开始前调用，清零调用次数。
   */
  restart(): void {
    this.callCount = 0;
  }

  private async getTableName(): Promise<string> {
    if (this._tableName === null) {
      this._tableName = await ensureAgentTable(this.agentName);
    }
    return this._tableName;
  }

  /**
   * 关键字召回：pg_trgm 的 word_similarity 衡量「query 与 content 某片段」的 trigram 相似度。
   * 只取有任何重叠（>0）的候选，按相似度降序拉 size 条。中文召回偏粗，但后面有 rerank 兜底。
   */
  private async bm25Search(query: string, size: number): Promise<DbRow[]> {
    const pool = getPgPool();
    try {
      const tableName = await this.getTableName();
      const sql =
        `SELECT id, content, metadata, word_similarity($1, content) AS score ` +
        `FROM ${tableName} ` +
        `WHERE word_similarity($1, content) > 0 ` +
        `ORDER BY score DESC ` +
        `LIMIT $2`;
      const resp = await pool.query(sql, [query, size]);
      return resp.rows as DbRow[];
    } catch (exc) {
      logger.warning(`[${this.agentName}] 关键字检索失败: ${String(exc)}`);
      return [];
    }
  }

  /**
   * 向量检索：query 算 embedding 后用 pgvector cosine 距离算子 `<=>` 取最近的 size 条。
   * score = 1 - 距离，语义上等价于余弦相似度（越大越相关）。
   */
  private async knnSearch(query: string, size: number): Promise<DbRow[]> {
    const pool = getPgPool();
    try {
      const tableName = await this.getTableName();
      const queryVec = await embed(query);
      const vectorLiteral = `[${queryVec.join(",")}]`;
      const sql =
        `SELECT id, content, metadata, 1 - (embedding <=> $1::vector) AS score ` +
        `FROM ${tableName} ` +
        `ORDER BY embedding <=> $1::vector ` +
        `LIMIT $2`;
      const resp = await pool.query(sql, [vectorLiteral, size]);
      return resp.rows as DbRow[];
    } catch (exc) {
      logger.warning(`[${this.agentName}] kNN 检索失败: ${String(exc)}`);
      return [];
    }
  }

  private merge(bm25Hits: DbRow[], knnHits: DbRow[]): DbRow[] {
    const seen = new Set<string>();
    const merged: DbRow[] = [];
    for (const hit of bm25Hits) {
      if (seen.has(hit.id)) {
        continue;
      }
      seen.add(hit.id);
      merged.push(hit);
    }
    for (const hit of knnHits) {
      if (seen.has(hit.id)) {
        continue;
      }
      seen.add(hit.id);
      merged.push(hit);
    }
    return merged;
  }

  /**
   * 混合检索 + 本地 rerank。`topN` 是 rerank 之后给 LLM 的条数。
   */
  async retrieve(query: string, topN?: number): Promise<RetrievedDoc[]> {
    this.callCount += 1; // 记一次调用，供面板标「用过 RAG」

    const settings = getSettings();
    const finalN = topN ?? settings.rerankTopN;
    const candidateN = settings.retrieveTopN;

    // 1) 关键字与向量两路并行检索，互不阻塞
    const [knnHits, bm25Hits] = await Promise.all([
      this.knnSearch(query, candidateN),
      this.bm25Search(query, candidateN),
    ]);

    // 2) 合并去重
    const merged = this.merge(bm25Hits, knnHits);
    if (merged.length === 0) {
      logger.info(`[${this.agentName}] 混合检索: 命中 0 条`);
      return [];
    }

    logger.info(
      `[${this.agentName}] 混合检索: 关键字 ${bm25Hits.length} + kNN ${knnHits.length} → 去重后 ${merged.length} 条 送入 rerank`,
    );

    // 3) 本地 cross-encoder rerank：取每条候选正文送重排
    const sourceContents: string[] = [];
    for (const hit of merged) {
      sourceContents.push(hit.content ?? "");
    }
    const reranked = await rerank(query, sourceContents, finalN);

    // 4) 按 rerank 顺序拼 RetrievedDoc
    const result: RetrievedDoc[] = [];
    for (const r of reranked) {
      const hit = merged[r.index];
      result.push({
        content: hit.content ?? "",
        metadata: hit.metadata ?? {},
        relevanceScore: r.relevanceScore,
      });
    }
    return result;
  }

  /**
   * 把 retrieve 封装成 LangChain Tool，供 LLM function-calling 调用。
   */
  getTool() {
    const description =
      `检索 ${this.agentName} 的私有知识库（工作日志 / 代码片段 / 设计文档）。` +
      "当你认为当前问题可能与历史经验、既有约定、过往实现相关时调用本工具；" +
      "若问题与本角色的历史经验无关，可不调用。" +
      "参数 query：自然语言查询字符串。";

    return tool(
      async ({ query }: { query: string }) => {
        const docs = await this.retrieve(query);
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
        name: `rag_search_${this.agentName}`,
        description,
        schema: z.object({
          query: z.string().describe("自然语言查询字符串"),
        }),
      },
    );
  }
}
