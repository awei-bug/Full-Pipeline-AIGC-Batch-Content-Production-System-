from __future__ import annotations

from ..generation_state import GenerationGraphState


async def prepare_context_node(state: GenerationGraphState) -> GenerationGraphState:
    request = state["request"]
    next_state = dict(state)
    next_state["current_stage"] = "prepare_context"
    next_state["progress"] = 12
    next_state["context"] = {
        "style_code": request.style_code or "cinematic",
        "aspect_ratio": request.aspect_ratio or "16:9",
        "duration_sec": request.duration_sec,
    }
    return next_state
