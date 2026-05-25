"""数据库层常量。"""

from meetmind.config.settings import get_settings


def get_index_name(agent_name: str) -> str:
    """
    返回某 agent 在 ES 中的 index 名字（`<prefix>_<agent>`）

    1 个 agent ↔ 1 个 ES index ↔ 类比关系型数据库的「一张表」
    """
    prefix = get_settings().es_index_prefix
    return f"{prefix}_{agent_name}"
