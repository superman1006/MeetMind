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
 * 检索逻辑（混合检索 + rerank）在 `retrieve()` 里；把它包成 LangChain Tool 的工厂
 * 见 `src/tools/ragSearchTool.ts`。
 */

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

  /** 绑定该检索器到指定 agent，表名由 getTableName(agentName) 决定。 */
  constructor(agentName: string) {
    this.agentName = agentName;
  }

  /**
   * 每轮 Agent.invoke() 开始前调用，清零调用次数。
   */
  restart(): void {
    this.callCount = 0;
  }

  /** 懒加载本 agent 对应的表名；首次会触发建表（含扩展 / 索引）。 */
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

  /** 关键字与向量两路命中按行 id 取并集；关键字结果优先排前，向量结果补在后。 */
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
}

// 每个 agent 一个 RAGRetriever，按 agent 名缓存复用。
// BaseAgent 和 rag_search 工具都通过 getRetriever 拿同一个实例，
// 这样工具里的检索调用次数能被 agent 的 used_rag 统计（callCount）感知到。
const _retrievers = new Map<string, RAGRetriever>();

/** 取（必要时新建）某 agent 的 RAGRetriever 单例。 */
export function getRetriever(agentName: string): RAGRetriever {
  let retriever = _retrievers.get(agentName);
  if (retriever === undefined) {
    retriever = new RAGRetriever(agentName);
    _retrievers.set(agentName, retriever);
  }
  return retriever;
}
