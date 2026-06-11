from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from ..config import Settings
from ..models import GeneratedOutput, WorkflowRequest, WorkflowResult

ProgressCallback = Callable[[int, str, str | None], Awaitable[None]]


class ModelScopeError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


def build_video_extra_headers(settings: Settings) -> dict[str, str]:
    headers = {
        "X-ModelScope-Async-Mode": "true",
    }
    if settings.modelscope_data_inspection:
        headers["X-ModelScope-DataInspection"] = settings.modelscope_data_inspection
    return headers


def aspect_to_modelscope_image_size(aspect_ratio: str | None) -> str:
    mapping = {
        "1:1": "1024x1024",
        "16:9": "1536x1024",
        "4:3": "1536x1024",
        "9:16": "1024x1536",
    }
    return mapping.get(aspect_ratio or "", "1536x1024")


class ModelScopeProvider:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def generate(
        self,
        workflow_task_id: str,
        payload: WorkflowRequest,
        on_progress: ProgressCallback | None = None,
    ) -> WorkflowResult:
        request_type = payload.request_type.strip()
        if request_type in {"text_to_image", "image_to_image"}:
            return await self._generate_image(workflow_task_id, payload, on_progress)
        if request_type in {"text_to_video", "image_to_video"}:
            return await self._generate_video(workflow_task_id, payload, on_progress)
        raise ModelScopeError("UNSUPPORTED_WORKFLOW", "暂不支持该生成类型")

    async def _generate_image(
        self,
        workflow_task_id: str,
        payload: WorkflowRequest,
        on_progress: ProgressCallback | None = None,
    ) -> WorkflowResult:
        create_payload = await self._create_task(
            "/images/generations",
            {
                "model": self._settings.modelscope_image_model,
                "prompt": payload.prompt,
                "parameters": {
                    "size": aspect_to_modelscope_image_size(payload.aspect_ratio),
                },
            },
            extra_headers={"X-ModelScope-Async-Mode": "true"},
            error_code="MODELSCOPE_IMAGE_FAILED",
            fallback_message="创建图片任务失败",
        )

        external_task_id = self._extract_task_id(create_payload)
        if not external_task_id:
            raise ModelScopeError(
                "MODELSCOPE_IMAGE_FAILED",
                "图片生成任务未返回任务编号",
                create_payload,
            )

        if on_progress:
            await on_progress(42, "图片任务已提交", external_task_id)

        result_payload = await self._poll_task(
            external_task_id,
            task_type_header="image_generation",
            max_attempts=self._settings.image_max_attempts,
            interval_sec=self._settings.image_poll_interval_sec,
            running_note="图片生成处理中",
            error_code="MODELSCOPE_IMAGE_FAILED",
            fallback_message="查询图片任务失败",
            on_progress=on_progress,
        )

        image_url = self._extract_image_url(result_payload)
        if not image_url:
            raise ModelScopeError(
                "MODELSCOPE_IMAGE_FAILED",
                "图片结果未返回可下载地址",
                result_payload,
            )

        file_name = f"{workflow_task_id}.png"
        file_path = self._settings.assets_dir / file_name
        await self._download_file(image_url, file_path)
        stat = file_path.stat()
        size = aspect_to_modelscope_image_size(payload.aspect_ratio)
        width, height = (1024, 1024)
        if size == "1024x1536":
            width, height = (1024, 1536)
        elif size == "1536x1024":
            width, height = (1536, 1024)

        return WorkflowResult(
            providerCode="modelscope",
            revisedPrompt=None,
            outputs=[
                GeneratedOutput(
                    assetType="image",
                    storageProvider="local",
                    objectKey=f"generated/{file_name}",
                    fileName=file_name,
                    mimeType="image/png",
                    fileSize=stat.st_size,
                    width=width,
                    height=height,
                    metadata={
                        "localPath": str(file_path),
                        "sourceUrl": image_url,
                        "publicUrl": f"/storage/assets/{file_name}",
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
        create_payload = await self._create_task(
            "/videos/generations",
            {
                "model": self._settings.modelscope_video_model,
                "prompt": payload.prompt,
            },
            extra_headers=build_video_extra_headers(self._settings),
            error_code="MODELSCOPE_VIDEO_FAILED",
            fallback_message="创建视频任务失败",
        )

        if create_payload.get("status") == "FAILED" or create_payload.get("errors"):
            raise self._build_error(
                create_payload,
                "MODELSCOPE_VIDEO_FAILED",
                "创建视频任务失败",
            )

        external_task_id = self._extract_task_id(create_payload)
        if not external_task_id:
            raise ModelScopeError(
                "MODELSCOPE_VIDEO_FAILED",
                "视频生成任务未返回任务编号",
                create_payload,
            )

        if on_progress:
            await on_progress(42, "视频任务已提交", external_task_id)

        result_payload = await self._poll_task(
            external_task_id,
            task_type_header="video_generation",
            max_attempts=self._settings.video_max_attempts,
            interval_sec=self._settings.video_poll_interval_sec,
            running_note="视频生成处理中",
            error_code="MODELSCOPE_VIDEO_FAILED",
            fallback_message="查询视频任务失败",
            on_progress=on_progress,
        )

        video_url = self._extract_video_url(result_payload)
        if not video_url:
            raise ModelScopeError(
                "MODELSCOPE_VIDEO_FAILED",
                "视频结果未返回可下载地址",
                result_payload,
            )

        file_path, mime_type = await self._download_video(workflow_task_id, video_url)
        stat = file_path.stat()

        return WorkflowResult(
            providerCode="modelscope",
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
                        "sourceUrl": video_url,
                        "publicUrl": f"/storage/assets/{file_path.name}",
                    },
                )
            ],
        )

    async def _create_task(
        self,
        endpoint: str,
        body: dict[str, Any],
        *,
        extra_headers: dict[str, str] | None,
        error_code: str,
        fallback_message: str,
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(
            timeout=self._settings.create_timeout_sec
        ) as client:
            response = await client.post(
                f"{self._settings.modelscope_base_url}{endpoint}",
                headers=self._build_headers(extra_headers),
                json=body,
            )
        payload = self._safe_json(response)
        if response.status_code >= 400:
            raise self._build_error(payload, error_code, fallback_message)
        return payload

    async def _poll_task(
        self,
        task_id: str,
        *,
        task_type_header: str,
        max_attempts: int,
        interval_sec: float,
        running_note: str,
        error_code: str,
        fallback_message: str,
        on_progress: ProgressCallback | None,
    ) -> dict[str, Any]:
        for attempt in range(max_attempts):
            await asyncio.sleep(interval_sec if attempt else max(interval_sec, 1.2))
            async with httpx.AsyncClient(
                timeout=self._settings.poll_timeout_sec
            ) as client:
                response = await client.get(
                    f"{self._settings.modelscope_base_url}/tasks/{task_id}",
                    headers=self._build_headers(
                        {"X-ModelScope-Task-Type": task_type_header}
                    ),
                )

            payload = self._safe_json(response)
            if response.status_code >= 400:
                raise self._build_error(payload, error_code, fallback_message)

            task_status = (
                payload.get("task_status")
                or payload.get("output", {}).get("task_status")
                or payload.get("status")
                or payload.get("output", {}).get("status")
            )

            if task_status in {"PROCESSING", "PENDING", "RUNNING"}:
                if on_progress:
                    progress = min(45 + attempt * 2, 72)
                    await on_progress(progress, running_note, task_id)
                continue

            if task_status in {"SUCCEED", "SUCCESS", "COMPLETED"}:
                return payload

            if task_status in {"FAILED", "FAIL", "CANCELED", "CANCELLED"}:
                message = (
                    payload.get("message")
                    or payload.get("errors", {}).get("message")
                    or payload.get("output", {}).get("message")
                    or payload.get("output", {}).get("error_message")
                    or "任务执行失败"
                )
                raise ModelScopeError(error_code, str(message), payload)

        raise ModelScopeError(error_code, "等待模型结果超时")

    async def _download_file(self, url: str, file_path: Path) -> None:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        async with httpx.AsyncClient(
            timeout=self._settings.download_timeout_sec,
            follow_redirects=True,
        ) as client:
            response = await client.get(url)
        if response.status_code >= 400:
            raise ModelScopeError(
                "MODELSCOPE_DOWNLOAD_FAILED",
                f"下载文件失败，状态码 {response.status_code}",
            )
        file_path.write_bytes(response.content)

    async def _download_video(self, workflow_task_id: str, url: str) -> tuple[Path, str]:
        async with httpx.AsyncClient(
            timeout=self._settings.download_timeout_sec,
            follow_redirects=True,
        ) as client:
            response = await client.get(url)
        if response.status_code >= 400:
            raise ModelScopeError(
                "MODELSCOPE_DOWNLOAD_FAILED",
                f"下载视频失败，状态码 {response.status_code}",
            )

        mime_type = response.headers.get("content-type", "video/mp4")
        suffix = self._infer_video_suffix(url, mime_type)
        file_path = self._settings.assets_dir / f"{workflow_task_id}.{suffix}"
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(response.content)
        return file_path, mime_type

    def _build_headers(self, extra_headers: dict[str, str] | None = None) -> dict[str, str]:
        if not self._settings.modelscope_api_token:
            raise ModelScopeError("MODELSCOPE_TOKEN_MISSING", "未配置魔塔访问令牌")
        headers = {
            "Authorization": f"Bearer {self._settings.modelscope_api_token}",
            "Content-Type": "application/json",
        }
        if extra_headers:
            headers.update(extra_headers)
        return headers

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
    ) -> ModelScopeError:
        message = (
            payload.get("message")
            or payload.get("errors", {}).get("message")
            or payload.get("error", {}).get("message")
            or payload.get("raw")
            or fallback_message
        )
        return ModelScopeError(error_code, str(message), payload)

    def _extract_task_id(self, payload: dict[str, Any]) -> str | None:
        return (
            payload.get("task_id")
            or payload.get("output", {}).get("task_id")
            or payload.get("output", {}).get("taskId")
        )

    def _extract_image_url(self, payload: dict[str, Any]) -> str | None:
        candidates = [
            payload.get("output_images", [None])[0],
            payload.get("output", {}).get("output_images", [None])[0],
            payload.get("output", {}).get("images", [None])[0],
            payload.get("images", [None])[0],
        ]
        for candidate in candidates:
            if isinstance(candidate, str) and candidate:
                return candidate
            if isinstance(candidate, dict) and candidate.get("url"):
                return str(candidate["url"])
        return None

    def _extract_video_url(self, payload: dict[str, Any]) -> str | None:
        candidates = [
            payload.get("output_video"),
            payload.get("output", {}).get("output_video"),
            payload.get("output", {}).get("video_url"),
            payload.get("video_url"),
            payload.get("output", {}).get("video"),
            payload.get("video"),
            payload.get("output", {}).get("result_url"),
            payload.get("result_url"),
            (payload.get("output_videos") or [None])[0],
            (payload.get("output", {}).get("output_videos") or [None])[0],
            (payload.get("output", {}).get("videos") or [None])[0],
            (payload.get("videos") or [None])[0],
        ]
        for candidate in candidates:
            if isinstance(candidate, str) and candidate:
                return candidate
            if isinstance(candidate, dict) and candidate.get("url"):
                return str(candidate["url"])
        return None

    def _infer_video_suffix(self, url: str, mime_type: str) -> str:
        normalized = url.split("?")[0].lower()
        if "quicktime" in mime_type or normalized.endswith(".mov"):
            return "mov"
        if "webm" in mime_type or normalized.endswith(".webm"):
            return "webm"
        if "gif" in mime_type or normalized.endswith(".gif"):
            return "gif"
        return "mp4"
