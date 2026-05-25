"""Cohere Rerank API 封装。

混合检索（ES BM25 + dense kNN）拉出 top-N 候选后，调本模块送给
`https://api.cohere.com/v2/rerank` 的 `rerank-v4.0-pro` 模型重排，
取 top-K 给 LLM。

API key 来自 settings.cohere_api_key（.env 里的 COHERE_API_KEY）。
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING

from meetmind.config.settings import get_settings
from meetmind.utils.logger import get_logger

if TYPE_CHECKING:
    from cohere import ClientV2

logger = get_logger(__name__)


@dataclass
class RerankedDoc:
    """rerank 之后的一条结果。

    - `index`           原候选列表里的下标，用来回查原文档对象
    - `relevance_score` Cohere 给的 0~1 相关性分数（越高越相关）
    """

    index: int
    relevance_score: float


@lru_cache(maxsize=1)
def get_cohere_client() -> "ClientV2":
    """单例 ClientV2；首次调用时实例化。

    不在模块加载时实例化，避免无 key 的纯单元测试爆 ImportError。
    """
    from cohere import ClientV2

    api_key = get_settings().cohere_api_key
    if not api_key:
        raise RuntimeError(
            "缺少 COHERE_API_KEY；请在 .env 里填上 Cohere 的 API key。"
        )
    return ClientV2(api_key=api_key)


def rerank(query: str, documents: list[str], top_n: int | None = None) -> list[RerankedDoc]:
    """让 Cohere 对候选文档按 query 重排序。

    返回长度 ≤ top_n 的 RerankedDoc 列表，**按 relevance_score 从高到低**。
    传入空 `documents` 直接返回 []，不调 API。
    """
    if not documents:
        return []

    settings = get_settings()
    if top_n is None:
        top_n = settings.rerank_top_n
    # top_n 不能超过候选数
    effective_top_n = min(top_n, len(documents))

    client = get_cohere_client()
    try:
        response = client.rerank(
            model=settings.cohere_rerank_model,
            query=query,
            documents=documents,
            top_n=effective_top_n,
        )
    except Exception as exc:
        logger.warning(f"[reranker] Cohere rerank 失败: {exc}；降级为返回前 {effective_top_n} 条原序")
        result: list[RerankedDoc] = []
        for i in range(effective_top_n):
            result.append(RerankedDoc(index=i, relevance_score=0.0))
        return result

    # response.results: list of objects with `.index` and `.relevance_score`
    reranked: list[RerankedDoc] = []
    for item in response.results:
        reranked.append(RerankedDoc(index=item.index, relevance_score=item.relevance_score))

    logger.info(
        f"[reranker] {len(documents)} 候选 → rerank → {len(reranked)} 条 "
        f"(top score {reranked[0].relevance_score:.3f})"
    )
    return reranked
