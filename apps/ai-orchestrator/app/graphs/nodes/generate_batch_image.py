from __future__ import annotations

from ..batch_generation_state import BatchGenerationState


async def generate_batch_image_node(
    state: BatchGenerationState,
    provider,
) -> BatchGenerationState:
    try:
        image_output = await provider.generate_image_asset(
            state["workflow_task_id"],
            state["product"],
            state["image_prompt"] or {},
        )
        state["outputs"].append(image_output)
    except Exception as error:  # noqa: BLE001
        state["degraded"] = True
        state["warnings"].append(
            {
                "stage": "image_asset",
                "code": "IMAGE_ASSET_FAILED",
                "message": str(error),
            }
        )
    return state
