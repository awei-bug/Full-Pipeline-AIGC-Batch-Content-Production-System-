from __future__ import annotations

from typing import Any

from ..config import Settings
from ..models import WorkflowRequest, WorkflowResult
from .modelscope import ModelScopeProvider
from .openai_video import OpenAIVideoProvider


class GenerationProvider:
    def __init__(
        self,
        settings: Settings,
        *,
        image_provider: Any | None = None,
        modelscope_video_provider: Any | None = None,
        openai_video_provider: Any | None = None,
    ) -> None:
        self._settings = settings
        self._image_provider = image_provider or ModelScopeProvider(settings)
        self._modelscope_video_provider = modelscope_video_provider or ModelScopeProvider(settings)
        self._openai_video_provider = openai_video_provider or OpenAIVideoProvider(settings)

    async def generate(
        self,
        workflow_task_id: str,
        payload: WorkflowRequest,
        on_progress=None,
    ) -> WorkflowResult:
        request_type = payload.request_type.strip()
        if request_type in {"text_to_image", "image_to_image"}:
            return await self._image_provider.generate(workflow_task_id, payload, on_progress)

        if request_type in {"text_to_video", "image_to_video"}:
            if self._settings.video_provider == "openai":
                return await self._openai_video_provider.generate(
                    workflow_task_id,
                    payload,
                    on_progress,
                )
            return await self._modelscope_video_provider.generate(
                workflow_task_id,
                payload,
                on_progress,
            )

        return await self._image_provider.generate(workflow_task_id, payload, on_progress)
