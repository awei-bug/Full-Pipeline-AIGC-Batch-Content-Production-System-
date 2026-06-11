from __future__ import annotations

from ...models import TaskEventPayload
from ..generation_state import GenerationGraphState


async def emit_failure_callback_node(
    state: GenerationGraphState,
    callback_client,
) -> GenerationGraphState:
    await callback_client.send_task_event(
        TaskEventPayload(
            taskId=state["request"].task_id,
            status="failed",
            providerCode=state.get("provider_code", "modelscope"),
            externalTaskId=state.get("external_task_id"),
            errorCode=state.get("error_code"),
            errorMessage=state.get("error_message"),
        )
    )
    next_state = dict(state)
    next_state["current_stage"] = "failed"
    return next_state
