from __future__ import annotations

from typing import Any, TypedDict

from app.models import WorkflowRequest, WorkflowResult

# current_stage keeps the active graph node name while running and switches to
# terminal lifecycle values only at the end: completed / failed.


class GenerationGraphState(TypedDict):
    workflow_task_id: str
    workflow_type: str
    provider_code: str
    request: WorkflowRequest
    current_stage: str
    progress: int
    result: WorkflowResult | None
    error_code: str | None
    error_message: str | None
    failed_node: str | None
    context: dict[str, Any]
    external_task_id: str | None


def build_initial_generation_state(
    workflow_task_id: str,
    payload: WorkflowRequest,
) -> GenerationGraphState:
    return GenerationGraphState(
        workflow_task_id=workflow_task_id,
        workflow_type=payload.request_type,
        provider_code="modelscope",
        request=payload,
        current_stage="validate_request",
        progress=0,
        result=None,
        error_code=None,
        error_message=None,
        failed_node=None,
        context={},
        external_task_id=None,
    )


def is_generation_request_valid(state: GenerationGraphState) -> bool:
    request = state["request"]
    workflow_type = state["workflow_type"].strip()
    if not request.prompt.strip():
        return False
    if request.request_type.strip() != workflow_type:
        return False
    return workflow_type in {
        "text_to_image",
        "image_to_image",
        "text_to_video",
        "image_to_video",
    }
