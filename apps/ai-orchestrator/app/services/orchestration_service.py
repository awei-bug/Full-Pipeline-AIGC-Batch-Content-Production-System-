from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from ..config import Settings
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
                build_initial_generation_state(workflow_task_id, payload)
            )
        except Exception as error:  # noqa: BLE001
            await self._handle_failure(
                workflow_task_id,
                payload.task_id,
                "ORCHESTRATOR_FAILED",
                str(error),
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

    async def _handle_failure(
        self,
        workflow_task_id: str,
        task_id: str,
        error_code: str,
        error_message: str,
    ) -> None:
        try:
            await self._callback_client.send_task_event(
                TaskEventPayload(
                    taskId=task_id,
                    status="failed",
                    providerCode="modelscope",
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
        return "modelscope"
