"""Per-agent RAG retrieval tool, wrapping Chroma similarity search."""

from __future__ import annotations

from dataclasses import dataclass

from langchain_core.tools import Tool

from meetmind.config.settings import get_settings
from meetmind.database.client import get_agent_collection
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class RetrievedDoc:
    content: str
    metadata: dict
    relevance: float

    def as_context_line(self) -> str:
        meta = self.metadata or {}
        tag = meta.get("type", "note")
        date = meta.get("date", "")
        return f"- [{tag}{' / ' + date if date else ''}] {self.content}"


class RAGRetriever:
    """Bound to a single agent's Chroma collection."""

    def __init__(self, agent_name: str):
        self.agent_name = agent_name
        self._collection = get_agent_collection(agent_name)

    def retrieve(self, query: str, top_k: int | None = None) -> list[RetrievedDoc]:
        if top_k is None:
            top_k = get_settings().rag_top_k

        try:
            results = self._collection.query(
                query_texts=[query],
                n_results=top_k,
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
        """Return the formatted context block used in prompts."""
        docs = self.retrieve(query, top_k=top_k)
        if not docs:
            return "(no relevant items in knowledge base)"
        return "\n".join(d.as_context_line() for d in docs)

    def add_documents(self, docs: list[dict]) -> int:
        """Add new documents at runtime (e.g. saving an outcome). Returns count added."""
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
        """Expose this retriever as a LangChain `Tool` for tool-using agents."""

        def _run(query: str) -> str:
            return self.retrieve_as_context(query)

        return Tool(
            name=f"rag_search_{self.agent_name}",
            description=(
                f"Search {self.agent_name}'s private knowledge base "
                "(work logs, code snippets, documents). Input: a natural-language query."
            ),
            func=_run,
        )
