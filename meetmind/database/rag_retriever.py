"""每个 Agent 私有的 RAG 检索工具：ES 混合检索 + Cohere rerank。

流程（针对一次 query）：
  1) BM25 检索：ES match query 拉 top_n_bm25 候选；
  2) 向量检索：query → embedding，ES dense_vector kNN 拉 top_n_knn 候选；
  3) 合并去重：按 ES _id 取并集；
  4) Cohere Rerank：把合并后的候选送 `rerank-v4.0-pro`，按相关性重排；
  5) 取 rerank 后的 top-K 给 LLM。

把检索器通过 `to_tool()` 暴露成 LangChain Tool，LLM 用 function-calling
按需调用，由 `BaseAgent.invoke()` 的 tool_calls 循环执行。
"""

from __future__ import annotations

from dataclasses import dataclass

from langchain_core.tools import Tool

from meetmind.config.settings import get_settings
from meetmind.database.client import get_agent_index, get_es_client
from meetmind.database.embedding import embed
from meetmind.database.reranker import rerank, RerankedDoc
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------- 数据类
@dataclass
class RetrievedDoc:
    """混合检索 + rerank 之后命中的单条结果。

    - `content`         原始文档文本
    - `metadata`        灌库时附加的 type / date / source
    - `relevance_score` Cohere rerank 的相关性分数 (0~1, 越大越相关)
    """

    content: str
    metadata: dict
    relevance_score: float = 0.0

    def as_context_line(self) -> str:
        """格式化为单行字符串，便于拼成 prompt 上下文块。"""
        meta = self.metadata or {}
        tag = meta.get("type") or "note"
        date = meta.get("date") or ""
        if date:
            return f"- [{tag} / {date}] {self.content}"
        return f"- [{tag}] {self.content}"



class RAGRetriever:
    """绑定到单个 agent 的 ES index，提供 (BM25 + 向量) 混合检索 + Cohere rerank。

    每个 Agent 实例化时持有一个独立的 RAGRetriever。
    `restart()` 在每轮 Agent.invoke() 开头被调用，只用于清零 call_count。
    """

    def __init__(self, agent_name: str):
        self.agent_name = agent_name
        # ensure_agent_index 是幂等的；这里调一次保证 index 存在
        self.index_name = get_agent_index(agent_name)
        # 本轮调用计数，BaseAgent 通过它判断是否要在面板上标 "📚 调用过 RAG"
        self.call_count: int = 0

    def restart(self) -> None:
        """每轮 Agent.invoke() 开始前调用，清零调用次数。"""
        self.call_count = 0

    # client.search()返回的结果的结构:
    # {
    #     "hits": {
    #         "total": {"value": 100},
    #         "hits": [
    #             {
    #                 "_id": "abc123",
    #                 "_score": 1.5,
    #                 "_source": {
    #                     "content": "用户认证采用 JWT 方案",
    #                     "metadata": {"type": "note", "date": "2024-01"}
    #                 }
    #             },
    #             {
    #                 同上
    #             }
    #         ]
    #     }
    # }

    def _bm25_search(self, query: str, size: int) -> list[dict]:
        """ES BM25 关键词检索。返回 list of {_id, score, _source} """
        client = get_es_client()

        # body 是 ES的 向量检索 指定请求格式
        # body 结构参考 ES DSL：https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-match-query.html
        body = {
            "query": {
                "match": {
                    "content": query
                }
            },
            "_source": ["content", "metadata"],
            "size": size,
        }
        try:
            resp = client.search(index=self.index_name, body=body)
        except Exception as exc:
            logger.warning(f"[{self.agent_name}] BM25 检索失败: {exc}")
            return []
        return list(resp["hits"]["hits"])

    def _knn_search(self, query: str, size: int) -> list[dict]:
        """ES dense_vector kNN 向量检索。"""
        client = get_es_client()
        query_vec = embed(query)
        # body 是 ES的 knn 指定请求格式
        # body 结构参考 ES DSL：https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-knn-query.html

        body = {
            "knn": {
                "field": "embedding",
                "query_vector": query_vec,
                "k": size,
                "num_candidates": max(size * 5, 100),
            },
            "_source": ["content", "metadata"],
            "size": size,
        }
        try:
            resp = client.search(index=self.index_name, body=body)
        except Exception as exc:
            logger.warning(f"[{self.agent_name}] kNN 检索失败: {exc}")
            return []
        return list(resp["hits"]["hits"])

    @staticmethod
    def _merge(bm25_hits: list[dict], knn_hits: list[dict]) -> list[dict]:
        """按 _id 取并集去重；保持顺序（BM25 在前，kNN 补充）。"""
        seen: set[str] = set()
        merged_content: list[dict] = []
        for hit in bm25_hits:
            doc_id = hit["_id"]
            if doc_id in seen:
                continue
            seen.add(doc_id)
            merged_content.append(hit)
        for hit in knn_hits:
            doc_id = hit["_id"]
            if doc_id in seen:
                continue
            seen.add(doc_id)
            merged_content.append(hit)
        return merged_content

    # ---------- 公开检索接口 ----------
    def retrieve(self, query: str, top_n: int | None = None) -> list[RetrievedDoc]:
        """混合检索 + Cohere rerank，返回最终的 top_n 条 RetrievedDoc。

        参数 `top_n` 是 rerank 之后给 LLM 的条数，默认取 Settings.rerank_top_n（5）。
        BM25 / kNN 各自捞的候选数走 Settings.retrieve_top_n（20）。
        """

        # 拿到 召回数 和 rerank 数
        settings = get_settings()
        # 调用一次 检索
        self.call_count += 1

        if top_n is None:
            top_n = settings.rerank_top_n
        candidate_n = settings.retrieve_top_n

        # 1) 两路检索
        knn_hits = self._knn_search(query, size=candidate_n)
        bm25_hits = self._bm25_search(query, size=candidate_n)

        # 2) 合并去重
        merged_hits = self._merge(bm25_hits, knn_hits)
        if not merged_hits:
            logger.info(f"[{self.agent_name}] 混合检索: 命中 0 条")
            return []

        logger.info(
            f"[{self.agent_name}] 混合检索: BM25 检索到{len(bm25_hits)}个 chunk + kNN 检索到{len(knn_hits)}个chunk "
            f"→ 去重后 {len(merged_hits)} 条chunks 送入 rerank"
        )

        # 3) Cohere rerank
        source_contents: list[str] = []
        for hit in merged_hits:
            # 拿到 文本数据
            content = hit["_source"].get("content", "")
            source_contents.append(content)

        reranked : list[RerankedDoc] = rerank(query=query, documents=source_contents, top_n=top_n)

        # 4) 按 rerank 顺序拼 RetrievedDoc
        result: list[RetrievedDoc] = []
        for r in reranked:
            hit = merged_hits[r.index]
            source = hit["_source"]
            doc = RetrievedDoc(
                content=source.get("content", ""),
                metadata=source.get("metadata") or {},
                relevance_score=r.relevance_score,
            )
            result.append(doc)

        return result



    def get_tool(self) -> Tool:
        """
        把_rag_search 封装成 LangChain Tool，供 LLM function-calling 调用。
        """

        def _rag_search(query: str) -> str:
            """返回用于 prompt / 工具结果的格式化上下文块。"""

            # 用 retrieve 获取文档
            docs = self.retrieve(query)
            if not docs:
                return "(知识库中未找到相关条目)"
            lines: list[str] = []
            for d in docs:
                lines.append(d.as_context_line())
            return "\n".join(lines)

        description : str= (
            f"检索 {self.agent_name} 的私有知识库（工作日志 / 代码片段 / 设计文档）。"
            "当你认为当前问题可能与历史经验、既有约定、过往实现相关时调用本工具；"
            "若问题与本角色的历史经验无关，可不调用。"
            "参数 query：自然语言查询字符串。"
        )
        return Tool(name=f"rag_search_{self.agent_name}", description=description, func=_rag_search)
