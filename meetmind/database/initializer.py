"""Bootstrap each agent's Chroma DB with seed documents."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from meetmind.config.constants import AGENT_NAMES
from meetmind.config.settings import get_settings
from meetmind.database.client import get_agent_client, get_agent_collection
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


def _load_seed_file(agent_name: str) -> list[dict]:
    seed_file = get_settings().seed_data_path / f"{agent_name}_seeds.json"
    if not seed_file.exists():
        logger.warning("No seed file for %s at %s", agent_name, seed_file)
        return []
    with open(seed_file, "r", encoding="utf-8") as f:
        return json.load(f)


def _seed_agent(agent_name: str) -> int:
    """Seed a single agent's collection. Skips already-seeded docs."""
    collection = get_agent_collection(agent_name)
    seeds = _load_seed_file(agent_name)
    if not seeds:
        return 0

    existing_ids = set(collection.get().get("ids") or [])

    ids: list[str] = []
    documents: list[str] = []
    metadatas: list[dict] = []
    for i, seed in enumerate(seeds):
        doc_id = f"{agent_name}_seed_{i}"
        if doc_id in existing_ids:
            continue
        ids.append(doc_id)
        documents.append(seed["content"])
        metadatas.append(
            {
                "type": seed.get("type", "note"),
                "date": seed.get("date", ""),
                "source": f"seed:{agent_name}",
            }
        )

    if ids:
        collection.add(ids=ids, documents=documents, metadatas=metadatas)
        logger.info("Seeded %s with %d new documents.", agent_name, len(ids))
    else:
        logger.info("%s already up to date (%d docs).", agent_name, len(existing_ids))

    return len(ids)


def initialize_all_agents() -> dict[str, int]:
    """Idempotent: seed every agent's DB, return number of new docs per agent."""
    results: dict[str, int] = {}
    for agent in AGENT_NAMES:
        results[agent] = _seed_agent(agent)
    return results


def reset_agent_db(agent_name: str) -> None:
    """Wipe and re-seed one agent's DB."""
    settings = get_settings()
    agent_dir: Path = settings.chroma_base_path / agent_name

    # Invalidate cached client before deleting the directory
    get_agent_client.cache_clear()

    if agent_dir.exists():
        shutil.rmtree(agent_dir)
        logger.info("Removed %s", agent_dir)

    _seed_agent(agent_name)
