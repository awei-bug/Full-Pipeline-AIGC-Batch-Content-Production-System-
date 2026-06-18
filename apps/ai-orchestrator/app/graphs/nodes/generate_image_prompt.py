from __future__ import annotations

from ..batch_generation_state import BatchGenerationState


async def generate_image_prompt_node(
    state: BatchGenerationState,
    provider,
) -> BatchGenerationState:
    state["image_prompt"] = await provider.generate_image_prompt(
        state["product"],
        state["copy"] or {},
        state["script"] or {},
    )
    return state
