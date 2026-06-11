from __future__ import annotations

from ..generation_state import GenerationGraphState


async def normalize_outputs_node(state: GenerationGraphState) -> GenerationGraphState:
    next_state = dict(state)
    next_state["current_stage"] = "normalize_outputs"
    next_state["progress"] = max(next_state.get("progress", 0), 85)
    return next_state
