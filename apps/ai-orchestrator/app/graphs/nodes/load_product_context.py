from __future__ import annotations

from ..batch_generation_state import BatchGenerationState


async def load_product_context_node(state: BatchGenerationState) -> BatchGenerationState:
    product = state["job_item"].get("productSnapshot") or {}
    state["product"] = product
    return state
