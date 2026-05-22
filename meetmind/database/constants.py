"""数据库相关常量。"""


def collection_name_for(agent_name: str) -> str:
    """返回某 agent 的标准 Chroma 集合名。"""
    return f"{agent_name}_knowledge"
