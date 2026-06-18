from __future__ import annotations

import asyncio
import inspect
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from ..config import Settings
from ..models import GeneratedOutput, WorkflowRequest, WorkflowResult
from .modelscope import aspect_to_modelscope_image_size
from .openai_video import aspect_to_openai_video_size

ProgressCallback = Callable[[int, str, str | None], Awaitable[None]]
SleepCallback = Callable[[float], Any]


class AgnesError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


class AgnesProvider:
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
        request_type = payload.request_type.strip()
        if request_type in {"text_to_image", "image_to_image"}:
            return await self._generate_image(workflow_task_id, payload)
        if request_type in {"text_to_video", "image_to_video"}:
            return await self._generate_video(workflow_task_id, payload, on_progress)
        raise AgnesError("UNSUPPORTED_WORKFLOW", "暂不支持该生成类型。")

    async def _generate_image(
        self,
        workflow_task_id: str,
        payload: WorkflowRequest,
    ) -> WorkflowResult:
        body = {
            "model": self._settings.agnes_image_model,
            "prompt": payload.prompt,
            "size": aspect_to_modelscope_image_size(payload.aspect_ratio),
        }
        async with self._client(timeout=self._settings.create_timeout_sec) as client:
            response = await client.post("/images/generations", json=body)

        parsed = self._safe_json(response)
        if response.status_code >= 400:
            raise self._build_error(parsed, "AGNES_IMAGE_FAILED", "Agnes 图片生成失败。")

        image_url = self._extract_image_url(parsed)
        if not image_url:
            raise AgnesError("AGNES_IMAGE_FAILED", "Agnes 图片结果缺少可下载地址。", parsed)

        file_path = self._settings.assets_dir / f"{workflow_task_id}.png"
        await self._download_binary(image_url, file_path)
        stat = file_path.stat()
        width, height = self._image_dimensions(payload.aspect_ratio)

        return WorkflowResult(
            providerCode="agnes",
            outputs=[
                GeneratedOutput(
                    assetType="image",
                    storageProvider="local",
                    objectKey=f"generated/{file_path.name}",
                    fileName=file_path.name,
                    mimeType="image/png",
                    fileSize=stat.st_size,
                    width=width,
                    height=height,
                    metadata={
                        "localPath": str(file_path),
                        "sourceUrl": image_url,
                        "publicUrl": f"/storage/assets/{file_path.name}",
                    },
                )
            ],
        )

    async def _generate_video(
        self,
        workflow_task_id: str,
        payload: WorkflowRequest,
        on_progress: ProgressCallback | None = None,
    ) -> WorkflowResult:
        body = {
            "model": self._settings.agnes_video_model,
            "prompt": payload.prompt,
            "size": aspect_to_openai_video_size(payload.aspect_ratio),
            "seconds": str(payload.duration_sec or 8),
        }
        parsed = await self._create_video_with_retry(body)

        video_id = str(parsed.get("id") or "")
        if not video_id:
            raise AgnesError("AGNES_VIDEO_FAILED", "Agnes 视频任务未返回 id。", parsed)

        if on_progress:
            await on_progress(42, "视频任务已提交。", video_id)

        completed = await self._poll_video(video_id, on_progress)
        file_path, mime_type = await self._download_video(workflow_task_id, video_id)
        stat = file_path.stat()

        return WorkflowResult(
            providerCode="agnes",
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
                        "sourceStatus": completed.get("status"),
                        "publicUrl": f"/storage/assets/{file_path.name}",
                    },
                )
            ],
        )

    async def _create_video_with_retry(self, body: dict[str, Any]) -> dict[str, Any]:
        max_attempts = 3
        for attempt in range(max_attempts):
            async with self._client(timeout=self._settings.create_timeout_sec) as client:
                response = await client.post("/videos", json=body)

            parsed = self._safe_json(response)
            if response.status_code < 400:
                return parsed

            if self._is_retryable_gateway_error(response) and attempt < max_attempts - 1:
                await self._wait(float(attempt + 1))
                continue

            if self._is_html_gateway_error(response):
                raise AgnesError(
                    "AGNES_VIDEO_FAILED",
                    f"Agnes 视频服务暂时不可用，上游返回 {response.status_code}。",
                    parsed,
                )
            raise self._build_error(parsed, "AGNES_VIDEO_FAILED", "Agnes 视频任务创建失败。")

        raise AgnesError("AGNES_VIDEO_FAILED", "Agnes 视频服务暂时不可用，请稍后重试。")

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
                if self._is_html_gateway_error(response):
                    raise AgnesError(
                        "AGNES_VIDEO_FAILED",
                        f"Agnes 视频服务暂时不可用，上游返回 {response.status_code}。",
                        parsed,
                    )
                raise self._build_error(parsed, "AGNES_VIDEO_FAILED", "Agnes 视频轮询失败。")

            status = str(parsed.get("status") or "").lower()
            if status in success_statuses:
                return parsed
            if status in failed_statuses:
                raise self._build_error(parsed, "AGNES_VIDEO_FAILED", "Agnes 视频任务失败。")
            if status in running_statuses:
                if on_progress:
                    await on_progress(min(45 + attempt * 2, 84), "视频生成中。", video_id)
                continue
            raise AgnesError(
                "AGNES_VIDEO_FAILED",
                f"未知 Agnes 视频状态: {status or 'empty'}",
                parsed,
            )

        raise AgnesError("AGNES_VIDEO_FAILED", "Agnes 视频任务等待超时。", {"video_id": video_id})

    async def _wait(self, seconds: float) -> None:
        result = self._sleep(seconds)
        if inspect.isawaitable(result):
            await result

    async def _download_video(self, workflow_task_id: str, video_id: str) -> tuple[Path, str]:
        response, parsed = await self._download_video_with_retry(video_id)

        file_path = self._settings.assets_dir / f"{workflow_task_id}.mp4"
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(response.content)
        return file_path, response.headers.get("content-type", "video/mp4")

    async def _download_video_with_retry(
        self,
        video_id: str,
    ) -> tuple[httpx.Response, dict[str, Any]]:
        max_attempts = 3
        for attempt in range(max_attempts):
            async with self._client(timeout=self._settings.download_timeout_sec) as client:
                response = await client.get(f"/videos/{video_id}/content")

            parsed = self._safe_json(response)
            if response.status_code < 400:
                return response, parsed

            if self._is_retryable_gateway_error(response) and attempt < max_attempts - 1:
                await self._wait(float(attempt + 1))
                continue

            if self._is_html_gateway_error(response):
                raise AgnesError(
                    "AGNES_DOWNLOAD_FAILED",
                    f"Agnes 视频下载服务暂时不可用，上游返回 {response.status_code}。",
                    parsed,
                )
            raise self._build_error(parsed, "AGNES_DOWNLOAD_FAILED", "Agnes 视频下载失败。")

        raise AgnesError("AGNES_DOWNLOAD_FAILED", "Agnes 视频下载服务暂时不可用，请稍后重试。")

    async def _download_binary(self, url: str, file_path: Path) -> None:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        async with httpx.AsyncClient(
            timeout=self._settings.download_timeout_sec,
            follow_redirects=True,
            transport=self._transport,
        ) as client:
            response = await client.get(url)
        if response.status_code >= 400:
            raise AgnesError(
                "AGNES_DOWNLOAD_FAILED",
                f"Agnes 资源下载失败，状态码 {response.status_code}",
            )
        file_path.write_bytes(response.content)

    def _client(self, timeout: float) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self._settings.agnes_base_url,
            timeout=timeout,
            headers=self._build_headers(),
            transport=self._transport,
        )

    def _build_headers(self) -> dict[str, str]:
        if not self._settings.agnes_api_key:
            raise AgnesError("AGNES_TOKEN_MISSING", "AGNES_API_KEY 未配置。")
        return {
            "Authorization": f"Bearer {self._settings.agnes_api_key}",
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
    ) -> AgnesError:
        message = (
            payload.get("message")
            or payload.get("error", {}).get("message")
            or payload.get("last_error", {}).get("message")
            or payload.get("raw")
            or fallback_message
        )
        return AgnesError(error_code, str(message), payload)

    def _is_html_gateway_error(self, response: httpx.Response) -> bool:
        content_type = str(response.headers.get("content-type") or "").lower()
        if "text/html" in content_type:
            return True
        body = response.text[:256].lower()
        return "<html" in body or "<!doctype html" in body

    def _is_retryable_gateway_error(self, response: httpx.Response) -> bool:
        return response.status_code in {502, 503, 504} and self._is_html_gateway_error(response)

    def _extract_image_url(self, payload: dict[str, Any]) -> str | None:
        first_data = (payload.get("data") or [None])[0]
        candidates = [
            first_data.get("url") if isinstance(first_data, dict) else None,
            payload.get("url"),
        ]
        for candidate in candidates:
            if isinstance(candidate, str) and candidate:
                return candidate
        return None

    def _image_dimensions(self, aspect_ratio: str | None) -> tuple[int, int]:
        size = aspect_to_modelscope_image_size(aspect_ratio)
        if size == "1024x1536":
            return (1024, 1536)
        if size == "1536x1024":
            return (1536, 1024)
        return (1024, 1024)
