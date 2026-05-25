"""按文件类型选择文本切块策略。

loaders.py 负责"按文件结构"切（PDF 每页 / DOCX 每段 / MD 整体），
本模块在 loader 输出之上再过一道"按长度"切，把过长的块切成适合 embedding 和
RAG 检索的小 chunk（chunk_size 字符 + 少量 overlap）。

不同类型用不同 splitter：
  - .json     不切（种子 JSON 通常已是短条）
  - .md       MarkdownHeaderTextSplitter 先按 `# / ##` 标题切，再过 Recursive
  - .pdf      RecursiveCharacterTextSplitter (chunk_size=600, overlap=80)
  - .docx     RecursiveCharacterTextSplitter (chunk_size=500, overlap=60)
  - .txt      RecursiveCharacterTextSplitter (chunk_size=500, overlap=60)
"""

from __future__ import annotations

from langchain_text_splitters import (
    MarkdownHeaderTextSplitter,
    RecursiveCharacterTextSplitter,
)

from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------- 各类型默认参数
_PARAMS = {
    "pdf":      {"chunk_size": 600, "chunk_overlap": 80},
    "docx":     {"chunk_size": 500, "chunk_overlap": 60},
    "txt":      {"chunk_size": 500, "chunk_overlap": 60},
    "markdown": {"chunk_size": 500, "chunk_overlap": 60},
}


def _recursive(chunk_size: int, chunk_overlap: int) -> RecursiveCharacterTextSplitter:
    """通用 Recursive splitter；中英文混排都能拆得动。"""
    return RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        separators=["\n\n", "\n", "。", "！", "？", ".", "!", "?", " ", ""],
        keep_separator=False,
    )


# ---------------------------------------------------------------- 每种文件类型一个方法

def split_json(docs: list[dict]) -> list[dict]:
    """JSON 不切：种子 JSON 通常是手写的短条目，按原样灌入。"""
    return docs


def split_markdown(docs: list[dict]) -> list[dict]:
    """Markdown：先按 `#/##/###` 标题切，再用 Recursive 限长。

    每个新 chunk 把它所属的 header 路径写进 metadata，便于将来调试或展示。
    """
    header_splitter = MarkdownHeaderTextSplitter(
        headers_to_split_on=[
            ("#", "h1"),
            ("##", "h2"),
            ("###", "h3"),
        ],
        strip_headers=False,
    )
    length_splitter = _recursive(**_PARAMS["markdown"])

    out: list[dict] = []
    for d in docs:
        content = d.get("content", "")
        if not content.strip():
            continue
        # 第一层：按标题切
        header_chunks = header_splitter.split_text(content)
        for hc in header_chunks:
            # 第二层：按长度切
            pieces = length_splitter.split_text(hc.page_content)
            for piece in pieces:
                meta = {**d, **{k: v for k, v in hc.metadata.items() if k != "content"}}
                meta["content"] = piece
                out.append(meta)
    return out


def split_pdf(docs: list[dict]) -> list[dict]:
    """PDF：每页一个 doc 进来，过长的页用 Recursive 切；保留 source（含 #pageN）。"""
    return _split_with_recursive(docs, **_PARAMS["pdf"])


def split_docx(docs: list[dict]) -> list[dict]:
    """DOCX：每段一个 doc 进来；过长段落用 Recursive 切，太短的段保持不变。"""
    return _split_with_recursive(docs, **_PARAMS["docx"])


def split_text(docs: list[dict]) -> list[dict]:
    """TXT / 其他纯文本：用 Recursive 切。"""
    return _split_with_recursive(docs, **_PARAMS["txt"])


def _split_with_recursive(docs: list[dict], chunk_size: int, chunk_overlap: int) -> list[dict]:
    """把一组 dict 里 `content` 字段过 Recursive splitter，保留其余 metadata。"""
    splitter = _recursive(chunk_size, chunk_overlap)
    out: list[dict] = []
    for d in docs:
        content = d.get("content", "")
        if not content.strip():
            continue
        pieces = splitter.split_text(content)
        if len(pieces) <= 1:
            out.append(d)
            continue
        for i, piece in enumerate(pieces):
            new_doc = dict(d)
            new_doc["content"] = piece
            # 在 source 上附加 chunk 序号，方便定位
            base_source = d.get("source", "")
            new_doc["source"] = f"{base_source}#chunk{i}" if base_source else f"chunk{i}"
            out.append(new_doc)
    return out


# ---------------------------------------------------------------- 顶层分发
_DISPATCH = {
    "json":     split_json,
    "markdown": split_markdown,
    "md":       split_markdown,
    "pdf":      split_pdf,
    "docx":     split_docx,
    "txt":      split_text,
    "text":     split_text,
}


def split_docs(docs: list[dict]) -> list[dict]:
    """根据每条 doc 的 `type` 字段分发到对应的 splitter。

    loaders 已经在 dict 里写了 `type`（如 'pdf' / 'markdown' / 'json' …），
    所以这里按 type 分组后批量切。未知类型走 split_text 兜底。
    """
    if not docs:
        return []

    # 按 type 分组
    by_type: dict[str, list[dict]] = {}
    for d in docs:
        t = (d.get("type") or "text").lower()
        by_type.setdefault(t, []).append(d)

    out: list[dict] = []
    for t, group in by_type.items():
        splitter_fn = _DISPATCH.get(t, split_text)
        chunks = splitter_fn(group)
        if len(chunks) != len(group):
            logger.info(f"[splitter] type={t} 原始 {len(group)} 段 → 切块 {len(chunks)} 段")
        out.extend(chunks)
    return out
