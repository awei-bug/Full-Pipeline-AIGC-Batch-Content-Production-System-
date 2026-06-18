from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from ..config import Settings
from ..graphs.batch_generation_graph import build_batch_generation_graph
from ..graphs.batch_generation_state import build_initial_batch_state
from ..graphs.generation_graph import build_generation_graph
from ..graphs.generation_state import build_initial_generation_state
from ..models import (
    TaskEventPayload,
    WorkflowAccepted,
    WorkflowRequest,
    WorkflowRunState,
)
from ..providers.generation_provider import GenerationProvider
from .callback_client import CallbackClient


class WorkflowStore:
    def __init__(self) -> None:
        self._runs: dict[str, WorkflowRunState] = {}

    def create_run(self, payload: WorkflowRunState) -> None:
        self._runs[payload.workflow_task_id] = payload

    def update_run(self, workflow_task_id: str, **changes: Any) -> WorkflowRunState | None:
        current = self._runs.get(workflow_task_id)
        if current is None:
            return None
        next_payload = current.model_copy(update=changes)
        self._runs[workflow_task_id] = next_payload
        return next_payload

    def get_run(self, workflow_task_id: str) -> WorkflowRunState | None:
        return self._runs.get(workflow_task_id)


class OrchestrationService:
    def __init__(
        self,
        settings: Settings,
        provider: GenerationProvider | None = None,
        callback_client: CallbackClient | None = None,
        store: WorkflowStore | None = None,
    ) -> None:
        self._settings = settings
        self._provider = provider or GenerationProvider(settings)
        self._callback_client = callback_client or CallbackClient(settings)
        self._store = store or WorkflowStore()
        self._graph = build_generation_graph(
            settings,
            self._provider,
            self._callback_client,
        )
        self._batch_graph = build_batch_generation_graph(self._provider)

    async def submit_generation(self, payload: WorkflowRequest) -> WorkflowAccepted:
        now = datetime.now(timezone.utc)
        workflow_task_id = f"wf_{uuid4().hex[:12]}"
        provider_code = self._provider_code_for(payload)
        run_state = WorkflowRunState(
            workflowTaskId=workflow_task_id,
            taskId=payload.task_id,
            creationRequestId=payload.creation_request_id,
            projectId=payload.project_id,
            workflowType=payload.request_type,
            providerCode=provider_code,
            status="created",
            progress=0,
            acceptedAt=now,
        )
        self._store.create_run(run_state)
        asyncio.create_task(self._run_workflow(workflow_task_id, payload))
        return WorkflowAccepted(
            workflowTaskId=workflow_task_id,
            workflowType=payload.request_type,
            providerCode=provider_code,
            status="created",
            acceptedAt=now.isoformat(),
        )

    async def submit_batch_item(self, payload: dict[str, Any]) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        workflow_task_id = f"wf_{uuid4().hex[:12]}"
        job_item_id = StringLike(payload.get("jobItemId")).value
        run_state = WorkflowRunState(
            workflowTaskId=workflow_task_id,
            taskId=job_item_id or workflow_task_id,
            creationRequestId=str(payload.get("jobId") or workflow_task_id),
            projectId=str(payload.get("productId") or "batch-project"),
            workflowType="batch_content_item",
            providerCode="batch",
            status="created",
            progress=0,
            acceptedAt=now,
        )
        self._store.create_run(run_state)
        asyncio.create_task(self._run_batch_item(workflow_task_id, payload))
        return {
            "workflowTaskId": workflow_task_id,
            "jobItemId": job_item_id,
            "status": "created",
        }

    def get_run(self, workflow_task_id: str) -> WorkflowRunState | None:
        return self._store.get_run(workflow_task_id)

    async def _run_workflow(
        self,
        workflow_task_id: str,
        payload: WorkflowRequest,
    ) -> None:
        started_at = datetime.now(timezone.utc)
        self._store.update_run(
            workflow_task_id,
            status="running",
            progress=5,
            started_at=started_at,
        )

        try:
            final_state = await self._graph.ainvoke(
                build_initial_generation_state(
                    workflow_task_id,
                    payload,
                    provider_code=self._provider_code_for(payload),
                )
            )
        except Exception as error:  # noqa: BLE001
            await self._handle_failure(
                workflow_task_id,
                payload.task_id,
                getattr(error, "code", "ORCHESTRATOR_FAILED"),
                str(error),
                self._provider_code_for(payload),
            )
            return

        finished_at = datetime.now(timezone.utc)
        if final_state.get("error_code"):
            self._store.update_run(
                workflow_task_id,
                status="failed",
                progress=final_state.get("progress", 0),
                finished_at=finished_at,
                error_code=final_state.get("error_code"),
                error_message=final_state.get("error_message"),
            )
            return

        result = final_state["result"]
        self._store.update_run(
            workflow_task_id,
            status="success",
            progress=final_state.get("progress", 100),
            finished_at=finished_at,
            result_summary={
                "outputCount": len(result.outputs),
                "providerCode": result.provider_code,
            },
        )

    async def _run_batch_item(
        self,
        workflow_task_id: str,
        payload: dict[str, Any],
    ) -> None:
        started_at = datetime.now(timezone.utc)
        self._store.update_run(
            workflow_task_id,
            status="running",
            progress=5,
            started_at=started_at,
        )

        try:
            final_state = await self._batch_graph.ainvoke(
                build_initial_batch_state(
                    workflow_task_id=workflow_task_id,
                    job_item=payload,
                )
            )
        except Exception as error:  # noqa: BLE001
            callback = getattr(self._callback_client, "send_batch_item_event", None)
            if callable(callback):
                await callback(
                    {
                        "jobItemId": StringLike(payload.get("jobItemId")).value,
                        "status": "failed",
                        "errorCode": "BATCH_ITEM_FAILED",
                        "errorMessage": str(error),
                    }
                )
            self._store.update_run(
                workflow_task_id,
                status="failed",
                error_code="BATCH_ITEM_FAILED",
                error_message=str(error),
                finished_at=datetime.now(timezone.utc),
            )
            return

        callback = getattr(self._callback_client, "send_batch_item_event", None)
        if callable(callback):
            await callback(
                {
                    "jobItemId": StringLike(payload.get("jobItemId")).value,
                    "status": "succeeded",
                    "outputs": final_state.get("outputs", []),
                    "usage": {
                        "estimatedTokens": 0,
                        "estimatedCost": 0,
                    },
                    "riskStatus": "degraded" if final_state.get("degraded") else "passed",
                    "warnings": final_state.get("warnings", []),
                }
            )

        self._store.update_run(
            workflow_task_id,
            status="success",
            progress=100,
            finished_at=datetime.now(timezone.utc),
            result_summary={
                "jobItemId": StringLike(payload.get("jobItemId")).value,
                "status": final_state.get("status", "success"),
                "outputCount": len(final_state.get("outputs", [])),
                "degraded": bool(final_state.get("degraded")),
            },
        )

    async def _handle_failure(
        self,
        workflow_task_id: str,
        task_id: str,
        error_code: str,
        error_message: str,
        provider_code: str,
    ) -> None:
        try:
            await self._callback_client.send_task_event(
                TaskEventPayload(
                    taskId=task_id,
                    status="failed",
                    providerCode=provider_code,
                    errorCode=error_code,
                    errorMessage=error_message,
                )
            )
        finally:
            self._store.update_run(
                workflow_task_id,
                status="failed",
                error_code=error_code,
                error_message=error_message,
                finished_at=datetime.now(timezone.utc),
            )

    def _provider_code_for(self, payload: WorkflowRequest) -> str:
        if payload.request_type.strip() in {"text_to_video", "image_to_video"}:
            return self._settings.video_provider
        if payload.request_type.strip() in {"text_to_image", "image_to_image"}:
            return self._settings.image_provider
        return self._settings.image_provider


class StringLike:
    def __init__(self, value: Any) -> None:
        self.value = str(value or "").strip()
