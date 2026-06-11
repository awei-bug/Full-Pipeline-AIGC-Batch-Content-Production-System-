from __future__ import annotations

import asyncio
import inspect
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from ..config import Settings
from ..models import GeneratedOutput, WorkflowRequest, WorkflowResult

ProgressCallback = Callable[[int, str, str | None], Awaitable[None]]
SleepCallback = Callable[[float], Any]


class OpenAIVideoError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


def aspect_to_openai_video_size(aspect_ratio: str | None) -> str:
    mapping = {
        "16:9": "1280x720",
        "9:16": "720x1280",
        "1:1": "1024x1024",
    }
    return mapping.get(aspect_ratio or "", "1280x720")


class OpenAIVideoProvider:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: SleepCallback | None = None,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._sleep = sleep or asyncio.sleep

    async def generate(
        self,
        workflow_task_id: str,
        payload: WorkflowRequest,
        on_progress: ProgressCallback | None = None,
    ) -> WorkflowResult:
        create_payload = await self._create_video(payload)
        video_id = str(create_payload.get("id") or "")
        if not video_id:
            raise OpenAIVideoError(
                "OPENAI_VIDEO_FAILED",
                "OpenAI video task did not return an id.",
                create_payload,
            )

        if on_progress:
            await on_progress(42, "OpenAI video task submitted.", video_id)

        completed_payload = await self._poll_video(video_id, on_progress)
        file_path, mime_type = await self._download_video(workflow_task_id, video_id)
        stat = file_path.stat()

        return WorkflowResult(
            providerCode="openai",
            revisedPrompt=None,
            outputs=[
                GeneratedOutput(
                    assetType="video",
                    storageProvider="local",
                    objectKey=f"generated/{file_path.name}",
                    fileName=file_path.name,
                    mimeType=mime_type,
                    fileSize=stat.st_size,
                    durationSec=payload.duration_sec,
                    metadata={
                        "localPath": str(file_path),
                        "sourceVideoId": video_id,
                        "sourceStatus": completed_payload.get("status"),
                        "publicUrl": f"/storage/assets/{file_path.name}",
                    },
                )
            ],
        )

    async def _create_video(self, payload: WorkflowRequest) -> dict[str, Any]:
        body = {
            "model": self._settings.openai_video_model,
            "prompt": payload.prompt,
            "size": aspect_to_openai_video_size(payload.aspect_ratio),
            "seconds": payload.duration_sec or 8,
        }
        async with self._client(timeout=self._settings.create_timeout_sec) as client:
            response = await client.post("/videos", json=body)

        parsed = self._safe_json(response)
        if response.status_code >= 400:
            raise self._build_error(parsed, "OPENAI_VIDEO_FAILED", "OpenAI video task creation failed.")
        return parsed

    async def _poll_video(
        self,
        video_id: str,
        on_progress: ProgressCallback | None,
    ) -> dict[str, Any]:
        running_statuses = {"queued", "in_progress", "processing", "running"}
        success_statuses = {"completed", "succeeded", "success"}
        failed_statuses = {"failed", "cancelled", "canceled"}

        for attempt in range(self._settings.video_max_attempts):
            await self._wait(self._settings.video_poll_interval_sec if attempt else 0)
            async with self._client(timeout=self._settings.poll_timeout_sec) as client:
                response = await client.get(f"/videos/{video_id}")

            parsed = self._safe_json(response)
            if response.status_code >= 400:
                raise self._build_error(parsed, "OPENAI_VIDEO_FAILED", "OpenAI video polling failed.")

            status = str(parsed.get("status") or "").lower()
            if status in success_statuses:
                return parsed
            if status in failed_statuses:
                raise self._build_error(parsed, "OPENAI_VIDEO_FAILED", "OpenAI video task failed.")
            if status in running_statuses:
                if on_progress:
                    await on_progress(
                        min(45 + attempt * 2, 84),
                        "OpenAI video task is running.",
                        video_id,
                    )
                continue

            raise OpenAIVideoError(
                "OPENAI_VIDEO_FAILED",
                f"Unknown OpenAI video task status: {status or 'empty'}",
                parsed,
            )

        raise OpenAIVideoError(
            "OPENAI_VIDEO_FAILED",
            "OpenAI video task timed out.",
            {"video_id": video_id},
        )

    async def _wait(self, seconds: float) -> None:
        result = self._sleep(seconds)
        if inspect.isawaitable(result):
            await result

    async def _download_video(self, workflow_task_id: str, video_id: str) -> tuple[Path, str]:
        async with self._client(timeout=self._settings.download_timeout_sec) as client:
            response = await client.get(f"/videos/{video_id}/content")

        if response.status_code >= 400:
            parsed = self._safe_json(response)
            raise self._build_error(parsed, "OPENAI_DOWNLOAD_FAILED", "OpenAI video download failed.")

        file_path = self._settings.assets_dir / f"{workflow_task_id}.mp4"
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(response.content)
        return file_path, response.headers.get("content-type", "video/mp4")

    def _client(self, timeout: float) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self._settings.openai_base_url,
            timeout=timeout,
            headers=self._build_headers(),
            transport=self._transport,
        )

    def _build_headers(self) -> dict[str, str]:
        if not self._settings.openai_api_key:
            raise OpenAIVideoError("OPENAI_TOKEN_MISSING", "OPENAI_API_KEY is not configured.")
        return {
            "Authorization": f"Bearer {self._settings.openai_api_key}",
            "Content-Type": "application/json",
        }

    def _safe_json(self, response: httpx.Response) -> dict[str, Any]:
        try:
            return response.json()
        except ValueError:
            return {"raw": response.text}

    def _build_error(
        self,
        payload: dict[str, Any],
        error_code: str,
        fallback_message: str,
    ) -> OpenAIVideoError:
        message = (
            payload.get("message")
            or payload.get("error", {}).get("message")
            or payload.get("last_error", {}).get("message")
            or payload.get("raw")
            or fallback_message
        )
        return OpenAIVideoError(error_code, str(message), payload)
