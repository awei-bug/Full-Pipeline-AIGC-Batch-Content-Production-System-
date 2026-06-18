from __future__ import annotations

from typing import Any, TypedDict


class BatchGenerationState(TypedDict):
    workflow_task_id: str
    job_item: dict[str, Any]
    product: dict[str, Any]
    copy: dict[str, Any] | None
    script: dict[str, Any] | None
    image_prompt: dict[str, Any] | None
    outputs: list[dict[str, Any]]
    status: str
    degraded: bool
    warnings: list[dict[str, Any]]
    error_code: str | None
    error_message: str | None


def build_initial_batch_state(*, workflow_task_id: str, job_item: dict[str, Any]) -> BatchGenerationState:
    return BatchGenerationState(
        workflow_task_id=workflow_task_id,
        job_item=job_item,
        product=job_item.get("productSnapshot") or {},
        copy=None,
        script=None,
        image_prompt=None,
        outputs=[],
        status="running",
        degraded=False,
        warnings=[],
        error_code=None,
        error_message=None,
    )
