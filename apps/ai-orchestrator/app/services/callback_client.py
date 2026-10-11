from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from ..config import Settings
from ..models import TaskEventPayload


class CallbackClient:
    _RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}

    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._sleep = sleep

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        token = getattr(self._settings, "internal_callback_token", None)
        if token:
            headers["X-Internal-Token"] = token
        return headers

    async def _post_json(
        self,
        path: str,
        payload: dict,
        error_message: str,
    ) -> None:
        if not self._settings.callback_base_url:
            raise RuntimeError("未配置业务接口回调地址")

        url = f"{self._settings.callback_base_url}{path}"
        max_attempts = max(1, self._settings.callback_max_attempts)
        for attempt in range(max_attempts):
            try:
                async with httpx.AsyncClient(
                    timeout=self._settings.create_timeout_sec,
                    transport=self._transport,
                ) as client:
                    response = await client.post(
                        url,
                        json=payload,
                        headers=self._headers(),
                    )
            except httpx.RequestError as error:
                if attempt >= max_attempts - 1:
                    raise RuntimeError(f"{error_message}：{error}") from error
            else:
                if response.status_code < 400:
                    return
                if response.status_code not in self._RETRYABLE_STATUS_CODES:
                    raise RuntimeError(
                        f"{error_message}，状态码 {response.status_code}"
                    )
                if attempt >= max_attempts - 1:
                    raise RuntimeError(
                        f"{error_message}，状态码 {response.status_code}"
                    )

            delay = self._settings.callback_backoff_sec * (2**attempt)
            if delay > 0:
                await self._sleep(delay)

    async def send_task_event(self, payload: TaskEventPayload) -> None:
        await self._post_json(
            "/internal/orchestrator/task-events",
            payload.model_dump(by_alias=True, exclude_none=True),
            "回调任务接口失败",
        )

    async def send_batch_item_event(self, payload: dict) -> None:
        await self._post_json(
            "/internal/batch-items/events",
            payload,
            "回调批量子任务接口失败",
        )
