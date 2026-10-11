from __future__ import annotations

import asyncio
import base64
import binascii
import inspect
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from ..config import Settings
from ..models import GeneratedOutput, WorkflowRequest, WorkflowResult

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
            "size": "1K",
            "ratio": payload.aspect_ratio or "1:1",
            "extra_body": {"response_format": "url"},
        }
        parsed = await self._create_image_with_retry(body)

        file_path = self._settings.assets_dir / f"{workflow_task_id}.png"
        image_url, image_base64 = self._extract_image_result(parsed)
        if image_url:
            await self._download_binary(image_url, file_path)
        elif image_base64:
            try:
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_bytes(base64.b64decode(image_base64, validate=True))
            except (ValueError, binascii.Error) as exc:
                raise AgnesError(
                    "AGNES_IMAGE_FAILED",
                    "Agnes 图片结果中的 Base64 数据无效。",
                    parsed,
                ) from exc
        else:
            raise AgnesError("AGNES_IMAGE_FAILED", "Agnes 图片结果缺少可下载地址。", parsed)

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
        width, height = self._video_dimensions(payload.aspect_ratio)
        frame_rate = 24
        num_frames = self._video_frame_count(payload.duration_sec or 8, frame_rate)
        body = {
            "model": self._settings.agnes_video_model,
            "prompt": payload.prompt,
            "negative_prompt": (
                "morphing product, changing product shape, inconsistent color or material, "
                "added or missing lid, handle or spout, duplicate product, warped hands, "
                "unreadable text, subtitles, watermark, logo, jump cuts, flicker, jitter"
            ),
            "width": width,
            "height": height,
            "num_frames": num_frames,
            "frame_rate": frame_rate,
        }
        parsed = await self._create_video_with_retry(body)

        video_id = str(parsed.get("video_id") or parsed.get("id") or "")
        if not video_id:
            raise AgnesError("AGNES_VIDEO_FAILED", "Agnes 视频任务未返回 id。", parsed)

        if on_progress:
            await on_progress(42, "视频任务已提交。", video_id)

        completed = await self._poll_video(video_id, on_progress)
        file_path, mime_type = await self._download_video(workflow_task_id, video_id, completed)
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
                    width=width,
                    height=height,
                    durationSec=payload.duration_sec,
                    metadata={
                        "localPath": str(file_path),
                        "sourceVideoId": video_id,
                        "sourceStatus": completed.get("status"),
                        "frameRate": frame_rate,
                        "numFrames": num_frames,
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
        running_statuses = {"queued", "pending", "in_progress", "processing", "running"}
        success_statuses = {"completed", "succeeded", "success"}
        failed_statuses = {"failed", "cancelled", "canceled"}

        for attempt in range(self._settings.video_max_attempts):
            await self._wait(self._settings.video_poll_interval_sec if attempt else 0)
            async with self._client(
                timeout=self._settings.poll_timeout_sec,
                base_url=self._agnes_root_url(),
            ) as client:
                response = await client.get(
                    "/agnesapi",
                    params={
                        "video_id": video_id,
                        "model_name": self._settings.agnes_video_model,
                    },
                )

            parsed = self._safe_json(response)
            if response.status_code >= 400:
                if self._is_html_gateway_error(response):
                    raise AgnesError(
                        "AGNES_VIDEO_FAILED",
                        f"Agnes 视频服务暂时不可用，上游返回 {response.status_code}。",
                        parsed,
                    )
                raise self._build_error(parsed, "AGNES_VIDEO_FAILED", "Agnes 视频轮询失败。")

            status = str(parsed.get("status") or "").strip().lower()
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

    async def _download_video(
        self,
        workflow_task_id: str,
        video_id: str,
        completed: dict[str, Any],
    ) -> tuple[Path, str]:
        file_path = self._settings.assets_dir / f"{workflow_task_id}.mp4"
        video_url = self._extract_video_url(completed)
        if not video_url:
            raise AgnesError(
                "AGNES_DOWNLOAD_FAILED",
                "Agnes 视频任务已完成，但结果中缺少 metadata.url。",
                {"video_id": video_id, **completed},
            )
        await self._download_binary(video_url, file_path)
        return file_path, "video/mp4"

    async def _download_binary(self, url: str, file_path: Path) -> None:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        async with httpx.AsyncClient(
            timeout=self._settings.download_timeout_sec,
            follow_redirects=True,
            transport=self._transport,
            trust_env=self._settings.agnes_trust_env,
        ) as client:
            response = await client.get(url)
        if response.status_code >= 400:
            raise AgnesError(
                "AGNES_DOWNLOAD_FAILED",
                f"Agnes 资源下载失败，状态码 {response.status_code}",
            )
        file_path.write_bytes(response.content)

    def _client(self, timeout: float, *, base_url: str | None = None) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=base_url or self._settings.agnes_base_url,
            timeout=timeout,
            headers=self._build_headers(),
            transport=self._transport,
            trust_env=self._settings.agnes_trust_env,
        )

    def _agnes_root_url(self) -> str:
        base_url = self._settings.agnes_base_url.rstrip("/")
        return base_url[:-3] if base_url.endswith("/v1") else base_url

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
        error = payload.get("error")
        last_error = payload.get("last_error")
        message = (
            payload.get("message")
            or payload.get("detail")
            or (error.get("message") if isinstance(error, dict) else error)
            or (last_error.get("message") if isinstance(last_error, dict) else last_error)
            or payload.get("raw")
            or fallback_message
        )
        message_text = str(message)
        normalized_code, normalized_message = self._normalize_error(
            error_code,
            message_text,
        )
        return AgnesError(normalized_code, normalized_message, payload)

    async def _create_image_with_retry(self, body: dict[str, Any]) -> dict[str, Any]:
        max_attempts = 3
        for attempt in range(max_attempts):
            try:
                async with self._client(timeout=self._settings.create_timeout_sec) as client:
                    response = await client.post("/images/generations", json=body)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if attempt < max_attempts - 1:
                    await self._wait(float(attempt + 1))
                    continue
                raise AgnesError(
                    "AGNES_IMAGE_FAILED",
                    "Agnes 图片服务连接失败，请稍后重试。",
                    {"reason": str(exc)},
                ) from exc

            parsed = self._safe_json(response)
            if response.status_code < 400:
                return parsed
            if response.status_code in {502, 503, 504} and attempt < max_attempts - 1:
                await self._wait(float(attempt + 1))
                continue
            raise self._build_error(parsed, "AGNES_IMAGE_FAILED", "Agnes 图片生成失败。")

        raise AgnesError("AGNES_IMAGE_FAILED", "Agnes 图片服务暂时不可用，请稍后重试。")

    def _normalize_error(self, error_code: str, message: str) -> tuple[str, str]:
        normalized = message.casefold()
        is_rate_limited = any(
            marker in normalized
            for marker in (
                "rate limit",
                "rate_limit",
                "too many requests",
                "token plan",
            )
        )
        if not is_rate_limited:
            return error_code, message

        if "free user" in normalized or "token plan" in normalized:
            return (
                "AGNES_RATE_LIMITED",
                "Agnes 免费额度已用完，请升级套餐或更换有额度的 API Key。",
            )
        return (
            "AGNES_RATE_LIMITED",
            "Agnes 请求已达到限额，请稍后重试或更换有额度的 API Key。",
        )

    def _is_html_gateway_error(self, response: httpx.Response) -> bool:
        content_type = str(response.headers.get("content-type") or "").lower()
        if "text/html" in content_type:
            return True
        body = response.text[:256].lower()
        return "<html" in body or "<!doctype html" in body

    def _is_retryable_gateway_error(self, response: httpx.Response) -> bool:
        return response.status_code in {502, 503, 504} and self._is_html_gateway_error(response)

    def _extract_image_result(self, payload: dict[str, Any]) -> tuple[str | None, str | None]:
        first_data = (payload.get("data") or [None])[0]
        if not isinstance(first_data, dict):
            return None, None
        image_url = first_data.get("url") or payload.get("url")
        image_base64 = first_data.get("b64_json")
        return (
            image_url if isinstance(image_url, str) and image_url else None,
            image_base64 if isinstance(image_base64, str) and image_base64 else None,
        )

    def _extract_video_url(self, payload: dict[str, Any]) -> str | None:
        metadata = payload.get("metadata")
        candidates = [
            metadata.get("url") if isinstance(metadata, dict) else None,
            payload.get("url"),
            payload.get("video_url"),
        ]
        for candidate in candidates:
            if isinstance(candidate, str) and candidate:
                return candidate
        return None

    def _image_dimensions(self, aspect_ratio: str | None) -> tuple[int, int]:
        dimensions = {
            "1:1": (1024, 1024),
            "3:4": (864, 1152),
            "4:3": (1152, 864),
            "16:9": (1312, 736),
            "9:16": (736, 1312),
            "2:3": (832, 1248),
            "3:2": (1248, 832),
            "21:9": (1568, 672),
        }
        return dimensions.get(aspect_ratio or "1:1", dimensions["1:1"])

    def _video_dimensions(self, aspect_ratio: str | None) -> tuple[int, int]:
        dimensions = {
            "1:1": (768, 768),
            "3:4": (768, 1024),
            "4:3": (1024, 768),
            "16:9": (1280, 720),
            "9:16": (720, 1280),
            "2:3": (768, 1152),
            "3:2": (1152, 768),
            "21:9": (1344, 576),
        }
        return dimensions.get(aspect_ratio or "16:9", dimensions["16:9"])

    def _video_frame_count(self, duration_sec: int, frame_rate: int) -> int:
        target_frames = max(1, duration_sec) * frame_rate
        normalized_frames = round((target_frames - 1) / 8) * 8 + 1
        return min(441, max(9, normalized_frames))
