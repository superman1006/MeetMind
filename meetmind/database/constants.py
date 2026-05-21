"""Database-related constants."""


def collection_name_for(agent_name: str) -> str:
    """Return the canonical Chroma collection name for an agent."""
    return f"{agent_name}_knowledge"
