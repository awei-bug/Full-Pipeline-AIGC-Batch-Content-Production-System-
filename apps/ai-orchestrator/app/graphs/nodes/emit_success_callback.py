from __future__ import annotations

from ...models import TaskEventPayload
from ..generation_state import GenerationGraphState


async def emit_success_callback_node(
    state: GenerationGraphState,
    callback_client,
) -> GenerationGraphState:
    result = state["result"]
    await callback_client.send_task_event(
        TaskEventPayload(
            taskId=state["request"].task_id,
            status="succeeded",
            providerCode=result.provider_code,
            revisedPrompt=result.revised_prompt,
            outputs=result.outputs,
        )
    )
    next_state = dict(state)
    next_state["current_stage"] = "completed"
    next_state["progress"] = 100
    return next_state
