from __future__ import annotations

from ..batch_generation_state import BatchGenerationState


async def generate_batch_video_node(
    state: BatchGenerationState,
    provider,
) -> BatchGenerationState:
    try:
        video_output = await provider.generate_video_asset(
            state["workflow_task_id"],
            state["product"],
            state["script"] or {},
        )
        state["outputs"].append(video_output)
    except Exception as error:  # noqa: BLE001
        state["degraded"] = True
        state["warnings"].append(
            {
                "stage": "video_asset",
                "code": "VIDEO_ASSET_FAILED",
                "message": str(error),
            }
        )
    return state
