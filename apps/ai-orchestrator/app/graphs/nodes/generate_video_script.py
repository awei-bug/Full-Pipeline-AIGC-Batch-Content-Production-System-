from __future__ import annotations

from ..batch_generation_state import BatchGenerationState


async def generate_video_script_node(
    state: BatchGenerationState,
    provider,
) -> BatchGenerationState:
    state["script"] = await provider.generate_script(state["product"], state["copy"] or {})
    return state
