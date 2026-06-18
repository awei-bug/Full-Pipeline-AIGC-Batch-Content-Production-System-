from __future__ import annotations

from ..batch_generation_state import BatchGenerationState


async def generate_marketing_copy_node(
    state: BatchGenerationState,
    provider,
) -> BatchGenerationState:
    state["copy"] = await provider.generate_copy(state["product"])
    return state
