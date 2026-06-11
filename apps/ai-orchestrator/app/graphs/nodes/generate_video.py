from __future__ import annotations

from ..generation_state import GenerationGraphState


async def generate_video_node(state: GenerationGraphState, provider) -> GenerationGraphState:
    next_state = dict(state)
    next_state["current_stage"] = "generate_video"
    next_state["progress"] = 40

    async def on_progress(progress: int, _note: str, external_task_id: str | None) -> None:
        next_state["progress"] = progress
        next_state["external_task_id"] = external_task_id

    try:
        result = await provider.generate(
            state["workflow_task_id"],
            state["request"],
            on_progress=on_progress,
        )
    except Exception as error:  # noqa: BLE001
        next_state["error_code"] = getattr(error, "code", "ORCHESTRATOR_FAILED")
        next_state["error_message"] = str(error)
        next_state["failed_node"] = "generate_video"
        next_state["current_stage"] = "failed"
        return next_state

    next_state["result"] = result
    next_state["provider_code"] = result.provider_code
    return next_state
