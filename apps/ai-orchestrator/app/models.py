from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class WorkflowRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project_id: str = Field(..., alias="projectId")
    creation_request_id: str = Field(..., alias="creationRequestId")
    task_id: str = Field(..., alias="taskId")
    prompt: str
    request_type: str = Field(default="text_to_image", alias="requestType")
    style_code: str | None = Field(default=None, alias="styleCode")
    aspect_ratio: str | None = Field(default=None, alias="aspectRatio")
    duration_sec: int | None = Field(default=None, alias="durationSec")


class WorkflowAccepted(BaseModel):
    workflow_task_id: str = Field(..., alias="workflowTaskId")
    workflow_type: str = Field(..., alias="workflowType")
    provider_code: str = Field(..., alias="providerCode")
    status: str
    accepted_at: str = Field(..., alias="acceptedAt")


class GeneratedOutput(BaseModel):
    asset_type: str = Field(..., alias="assetType")
    storage_provider: str = Field(..., alias="storageProvider")
    object_key: str = Field(..., alias="objectKey")
    file_name: str | None = Field(default=None, alias="fileName")
    mime_type: str | None = Field(default=None, alias="mimeType")
    file_size: int | None = Field(default=None, alias="fileSize")
    width: int | None = None
    height: int | None = None
    duration_sec: int | None = Field(default=None, alias="durationSec")
    metadata: dict[str, Any] = Field(default_factory=dict)


class WorkflowResult(BaseModel):
    provider_code: str = Field(..., alias="providerCode")
    revised_prompt: str | None = Field(default=None, alias="revisedPrompt")
    outputs: list[GeneratedOutput] = Field(default_factory=list)


class WorkflowRunState(BaseModel):
    workflow_task_id: str = Field(..., alias="workflowTaskId")
    task_id: str = Field(..., alias="taskId")
    creation_request_id: str = Field(..., alias="creationRequestId")
    project_id: str = Field(..., alias="projectId")
    workflow_type: str = Field(..., alias="workflowType")
    provider_code: str = Field(..., alias="providerCode")
    status: str
    progress: int = 0
    accepted_at: datetime = Field(..., alias="acceptedAt")
    started_at: datetime | None = Field(default=None, alias="startedAt")
    finished_at: datetime | None = Field(default=None, alias="finishedAt")
    error_code: str | None = Field(default=None, alias="errorCode")
    error_message: str | None = Field(default=None, alias="errorMessage")
    result_summary: dict[str, Any] | None = Field(default=None, alias="resultSummary")


class TaskEventPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    task_id: str = Field(..., alias="taskId")
    status: str
    provider_code: str | None = Field(default=None, alias="providerCode")
    external_task_id: str | None = Field(default=None, alias="externalTaskId")
    revised_prompt: str | None = Field(default=None, alias="revisedPrompt")
    outputs: list[GeneratedOutput] = Field(default_factory=list)
    error_code: str | None = Field(default=None, alias="errorCode")
    error_message: str | None = Field(default=None, alias="errorMessage")
