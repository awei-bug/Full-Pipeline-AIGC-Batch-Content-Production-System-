from __future__ import annotations

import httpx

from ..config import Settings
from ..models import TaskEventPayload


class CallbackClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def send_task_event(self, payload: TaskEventPayload) -> None:
        if not self._settings.callback_base_url:
            raise RuntimeError("未配置业务接口回调地址")

        async with httpx.AsyncClient(timeout=self._settings.create_timeout_sec) as client:
            response = await client.post(
                f"{self._settings.callback_base_url}/internal/orchestrator/task-events",
                json=payload.model_dump(by_alias=True, exclude_none=True),
            )

        if response.status_code >= 400:
            raise RuntimeError(
                f"回调业务接口失败，状态码 {response.status_code}"
            )
