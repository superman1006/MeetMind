"""文本 → 稠密向量。

用 sentence-transformers 在本地加载模型（默认 `all-MiniLM-L6-v2`，384 维），
和原先 chromadb 内置的 ONNX 模型同一份，保证迁移到 ES 后向量空间不变。
模型只在第一次调用 `get_embedder()` 时加载并被 lru_cache 缓存。
"""

from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING

from meetmind.config.settings import get_settings
from meetmind.utils.logger import get_logger

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer

logger = get_logger(__name__)


@lru_cache(maxsize=1)
def get_embedder_model() -> "SentenceTransformer":
    """加载 sentence-transformers 模型，单例缓存。

    首次调用会从 HuggingFace 下载约 80MB 权重到 `~/.cache/huggingface/`；
    之后启动是秒级。
    """
    # 延迟 import：sentence-transformers 拉 torch，import 本身就要 1-2 秒
    from sentence_transformers import SentenceTransformer

    model_name = get_settings().embedding_model_name
    model = SentenceTransformer(model_name)
    logger.info(f"[embedding] 加载完成，维度 {model.get_embedding_dimension()}")
    return model



def get_embed_model_dim() -> int:
    """返回当前模型的向量维度（建索引 mapping 时需要）。"""
    embed_model = get_embedder_model()
    return embed_model.get_embedding_dimension()


def embed(text: str) -> list[float]:
    """编码单条文本。"""
    embed_model = get_embedder_model()
    vec = embed_model.encode(text, normalize_embeddings=True)
    return vec.tolist()


def embed_batch(texts: list[str], batch_size: int = 32) -> list[list[float]]:
    """批量编码；返回与输入等长的 list[list[float]]。"""
    if not texts:
        return []
    embed_model = get_embedder_model()
    vecs = embed_model.encode(
        texts,
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    result: list[list[float]] = []
    for v in vecs:
        result.append(v.tolist())
    return result
