"""用种子文档初始化每个 agent 的 Chroma 数据库。

种子目录结构：
    data/seed/
        architect/    ← 这个子目录里的所有支持格式文件都会被灌入 architect 的 collection
            seeds.json
            roadmap.pdf
            decisions.md
        backend/
            seeds.json
            api_spec.docx
        ...

每个文件按其后缀走 `loaders.py` 里对应的 loader：
    .json  → load_json
    .md    → load_markdown
    .pdf   → load_pdf
    .docx  → load_docx
    .txt   → load_text
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from meetmind.config.constants import AGENT_NAMES
from meetmind.config.settings import get_settings
from meetmind.database.client import get_agent_client, get_agent_collection
from meetmind.database.loaders import load_file
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


def _agent_seed_dir(agent_name: str) -> Path:
    """返回 `data/seed/<agent_name>/`。"""
    return get_settings().seed_data_path / agent_name


def _get_seeds_content(agent_name: str) -> list[dict]:
    """扫描 agent 子目录下所有受支持的文件，返回合并后的文档列表。
    如果新结构目录不存在，回退到旧文件 `<agent>_seeds.json`（向后兼容）。
    返回的内容是
    [
        {
            "content": "这是文档内容，字符串",
            "type": "note",  # 可选，默认为 "note"，表示文档类型；也可以是 "decision"、"requirement" 等，后续可用于分类检索
            "date": "2024-06-01",  # 可选，表示文档的日期，字符串格式不限，但建议统一规范（如 ISO 8601）
            "source": "roadmap.pdf",  # 可选，表示文档来源，如文件名或 URL，便于后续追溯
        },
        ...
    ]
    """
    agent_dir = _agent_seed_dir(agent_name)

    if not agent_dir.exists():
        # 兼容旧布局：data/seed/<agent>_seeds.json
        legacy_file = get_settings().seed_data_path / f"{agent_name}_seeds.json"
        if legacy_file.exists():
            return load_file(legacy_file)
        logger.warning("没有 %s 的种子目录或旧种子文件", agent_name)
        return []

    docs: list[dict] = []
    for path in sorted(agent_dir.iterdir()):
        if not path.is_file() or path.name.startswith("."):
            continue
        loaded = load_file(path)
        if loaded:
            logger.info("[%s] 从 %s 加载了 %d 段", agent_name, path.name, len(loaded))
        docs.extend(loaded)
    return docs


def _generate_doc_id(agent_name: str, content: str) -> str:
    """基于内容 hash 生成稳定的 doc_id —— 同内容只灌一次，幂等。"""
    digest = hashlib.md5(content.encode("utf-8")).hexdigest()[:12]
    return f"{agent_name}_{digest}"


def _update_agent_collection(agent_name: str) -> int:
    """把 agent 子目录下所有文件解析后写入其 Chroma collection。

    通过基于内容 hash 的 doc_id 实现幂等：再次运行时已存在的文档会被跳过，
    返回值是【这次新增】的文档数量。
    """
    collection = get_agent_collection(agent_name)
    seeds_contents = _get_seeds_content(agent_name)
    if not seeds_contents:
        return 0

    existing_ids = set(collection.get().get("ids") or [])

    ids: list[str] = []
    documents: list[str] = []
    metadatas: list[dict] = []
    for seed in seeds_contents:
        content = seed.get("content", "").strip()
        if not content:
            continue
        
        # 获得文档的唯一标识 ID
        doc_id = _generate_doc_id(agent_name, content)
        
        # 如果有相同 id 的在库里则跳过
        if doc_id in existing_ids:
            continue
        ids.append(doc_id)
        documents.append(content)
        metadatas.append(
            {
                "type": seed.get("type", "note"),
                "date": seed.get("date", ""),
                "source": seed.get("source", f"seed:{agent_name}"),
            }
        )

    if ids:
        # 往 collection 里批量添加新文档；已存在的 id 会被 collection 自动忽略，不会覆盖原文档
        # 这一步就是在 Chroma 数据库里创建新记录，文档内容会被 embedding 然后存储
        collection.add(ids=ids, documents=documents, metadatas=metadatas)
        logger.info("已为 %s 新增 %d 条文档", agent_name, len(ids))
    else:
        logger.info("%s 已是最新（共 %d 条）", agent_name, len(existing_ids))

    return len(ids)


def initialize_all_agents() -> dict[str, int]:
    """为所有 agent 灌入种子数据（幂等）。返回每个 agent 本次新增的文档数。"""
    return {agent: _update_agent_collection(agent) for agent in AGENT_NAMES}


def reset_agent_db(agent_name: str) -> None:
    """清空并重新灌入单个 agent 的数据库。"""
    settings = get_settings()
    agent_dir: Path = settings.chroma_base_path / agent_name

    # 删除目录前要先清掉缓存的 PersistentClient（它持有目录的句柄）
    get_agent_client.cache_clear()

    if agent_dir.exists():
        shutil.rmtree(agent_dir)
        logger.info("已删除 %s", agent_dir)

    _update_agent_collection(agent_name)
