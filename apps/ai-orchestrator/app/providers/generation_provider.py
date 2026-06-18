from __future__ import annotations

from typing import Any

from ..config import Settings
from ..models import WorkflowRequest, WorkflowResult
from .agnes import AgnesProvider
from .agnes_text import AgnesTextProvider
from .modelscope import ModelScopeProvider
from .modelscope_text import ModelScopeTextProvider
from .openai_video import OpenAIVideoProvider


class GenerationProvider:
    def __init__(
        self,
        settings: Settings,
        *,
        image_provider: Any | None = None,
        modelscope_video_provider: Any | None = None,
        openai_video_provider: Any | None = None,
        agnes_video_provider: Any | None = None,
        text_provider: Any | None = None,
    ) -> None:
        self._settings = settings
        self._image_provider = image_provider or self._build_image_provider(settings)
        self._modelscope_video_provider = modelscope_video_provider or ModelScopeProvider(settings)
        self._openai_video_provider = openai_video_provider or OpenAIVideoProvider(settings)
        self._agnes_video_provider = agnes_video_provider or AgnesProvider(settings)
        self._text_provider = text_provider or self._build_text_provider(settings)

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
            if self._settings.video_provider == "agnes":
                return await self._agnes_video_provider.generate(
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

    async def generate_copy(self, product: dict[str, Any]) -> dict[str, Any]:
        return await self._text_provider.generate_copy(product)

    async def generate_script(self, product: dict[str, Any], copy: dict[str, Any]) -> dict[str, Any]:
        return await self._text_provider.generate_script(product, copy)

    async def generate_image_prompt(
        self,
        product: dict[str, Any],
        copy: dict[str, Any],
        script: dict[str, Any],
    ) -> dict[str, Any]:
        return await self._text_provider.generate_image_prompt(product, copy, script)

    async def generate_image_asset(
        self,
        workflow_task_id: str,
        product: dict[str, Any],
        image_prompt: dict[str, Any],
    ) -> dict[str, Any]:
        prompt = str(image_prompt.get("prompt") or "").strip()
        payload = WorkflowRequest(
            projectId=str(product.get("id") or "batch-project"),
            creationRequestId=f"batch_{workflow_task_id}",
            taskId=f"batch_{workflow_task_id}",
            prompt=prompt or f"{product.get('name', '商品')}商品海报",
            requestType="text_to_image",
            aspectRatio="1:1",
        )
        result = await self._image_provider.generate(workflow_task_id, payload)
        first_output = result.outputs[0]
        return {
            "outputType": "image_asset",
            "outputData": first_output.model_dump(by_alias=True),
        }

    def _build_image_provider(self, settings: Settings) -> Any:
        if settings.image_provider == "agnes":
            return AgnesProvider(settings)
        return ModelScopeProvider(settings)

    def _build_text_provider(self, settings: Settings) -> Any:
        if settings.text_provider == "agnes":
            return AgnesTextProvider(settings)
        return ModelScopeTextProvider(settings)
