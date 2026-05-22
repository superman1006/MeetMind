"""每个 Agent 私有的 RAG 检索工具。

封装对该 Agent 专属 Chroma collection 的相似度查询，并能以
`langchain_core.tools.Tool` 的形式暴露给 LLM 做 function-calling。
"""

from __future__ import annotations

from dataclasses import dataclass

from langchain_core.tools import Tool

from meetmind.config.settings import get_settings
from meetmind.database.client import get_agent_collection
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class RetrievedDoc:
    """Chroma 一次查询命中的单条结果。
    - `content`   原始文档文本
    - `metadata`  灌库时附加的元数据（type / date / source）
    - `relevance` 由距离换算而来的相似度（1 - distance，越大越相关）
    """

    content: str
    metadata: dict
    relevance: float

    def as_context_line(self) -> str:
        """格式化为单行字符串，便于拼成 prompt 上下文块。"""
        meta = self.metadata or {}
        tag = meta.get("type", "note")
        date = meta.get("date", "")
        return f"- [{tag}{' / ' + date if date else ''}] {self.content}"


class RAGRetriever:
    """绑定到单个 agent 的 Chroma 集合。

    除了检索本身，还跟踪两件事供调用方读取：
      - `call_count`：本轮内被 LLM 调用了多少次（重置由 `reset_tracking()` 触发）
      - `last_query_sources`：最后一次检索命中的 source 列表
    """

    def __init__(self, agent_name: str):
        self.agent_name = agent_name
        self._collection = get_agent_collection(agent_name)
        # 调用追踪 —— 在一轮 Agent.process() 里复用，便于上报 used_rag / rag_sources
        self.call_count: int = 0
        self.last_query_sources: list[str] = []

    def restart(self) -> None:
        """每轮 Agent.process() 开始前调用，清零调用次数和来源记录。"""
        self.call_count = 0
        self.last_query_sources = []

    def retrieve(self, query: str, top_k: int | None = None) -> list[RetrievedDoc]:
        """对 query 做语义检索，返回 top_k 条 RetrievedDoc。

        `top_k` 未指定时取 Settings.rag_top_k（默认 3）。
        失败会被吞掉并打 warning，返回空列表，调用方不必再做异常处理。
        """
        if top_k is None:
            top_k = get_settings().rag_top_k

        try:
            # Chroma 收到 query_texts 后，会用内置的 ONNX MiniLM 模型把这段文字转成一个向量，然后在数据库里找余弦距离最近的 3 条记录返回
            results = self._collection.query(
                query_texts=[query],
                n_results=top_k,
                # 只返回这三个字段，默认还会返回 ids 和 embeddings，但我们不需要
                include=["documents", "metadatas", "distances"],
            )
        except Exception as exc:
            logger.warning("[%s] RAG query failed: %s", self.agent_name, exc)
            return []

        docs = results.get("documents", [[]])[0]
        metas = results.get("metadatas", [[]])[0]
        dists = results.get("distances", [[]])[0]

        return [
            RetrievedDoc(
                content=doc,
                metadata=meta or {},
                relevance=max(0.0, 1.0 - float(dist)),
            )
            for doc, meta, dist in zip(docs, metas, dists)
        ]

    def retrieve_as_context(self, query: str, top_k: int | None = None) -> str:
        """返回用于提示词 / 工具结果的格式化上下文块；同时更新调用追踪状态。"""
        docs = self.retrieve(query, top_k=top_k)
        self.call_count += 1
        self.last_query_sources = [d.metadata.get("source", "") for d in docs]
        if not docs:
            return "(知识库中未找到相关条目)"
        return "\n".join(d.as_context_line() for d in docs)

    def add_documents(self, docs: list[dict]) -> int:
        """运行时往该 agent 的 collection 增量写入文档。

        典型用途：把一轮讨论的产物（例如新的决策、代码片段）回写进 RAG，
        让该 agent 下次能"记起"自己说过什么。doc_id 用时间戳保证唯一。
        返回实际写入的条数。
        """
        if not docs:
            return 0
        import time

        ids = [f"{self.agent_name}_run_{int(time.time() * 1000)}_{i}" for i in range(len(docs))]
        self._collection.add(
            ids=ids,
            documents=[d["content"] for d in docs],
            metadatas=[
                {
                    "type": d.get("type", "note"),
                    "date": d.get("date", ""),
                    "source": d.get("source", "runtime"),
                }
                for d in docs
            ],
        )
        return len(docs)

    def as_langchain_tool(self) -> Tool:
        """把检索器暴露为 LangChain `Tool`，供 LLM 通过 function-calling 调用。

        工具名为 `rag_search_<agent_name>`，参数是一个自然语言 `query` 字符串，
        返回格式化后的检索结果（每行一条命中文档）。
        """

        def _run(query: str) -> str:
            return self.retrieve_as_context(query)

        return Tool(
            name=f"rag_search_{self.agent_name}",
            description=(
                f"检索 {self.agent_name} 的私有知识库（工作日志 / 代码片段 / 设计文档）。"
                "当你认为当前问题可能与历史经验、既有约定、过往实现相关时调用本工具；"
                "若问题与本角色的历史经验无关，可不调用。"
                "参数 query：自然语言查询字符串。"
            ),
            func=_run,
        )
