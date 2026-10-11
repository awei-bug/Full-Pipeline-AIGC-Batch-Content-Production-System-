from __future__ import annotations

import unittest

import httpx

from app.config import Settings
from app.models import TaskEventPayload
from app.services.callback_client import CallbackClient


class CallbackClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_temporary_failure_with_exponential_backoff(self):
        calls = []
        sleeps = []

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(503, request=request)
            return httpx.Response(200, request=request)

        async def fake_sleep(delay: float) -> None:
            sleeps.append(delay)

        client = CallbackClient(
            Settings(
                callback_base_url="http://callback.test",
                internal_callback_token="secret",
                callback_max_attempts=3,
                callback_backoff_sec=0.25,
            ),
            transport=httpx.MockTransport(handler),
            sleep=fake_sleep,
        )

        await client.send_task_event(
            TaskEventPayload(taskId="task-1", status="succeeded")
        )

        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [0.25])
        self.assertEqual(calls[0].url.path, "/internal/orchestrator/task-events")
        self.assertEqual(calls[0].headers["x-internal-token"], "secret")

    async def test_does_not_retry_non_temporary_client_error(self):
        calls = []

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(401, request=request)

        client = CallbackClient(
            Settings(
                callback_base_url="http://callback.test",
                callback_max_attempts=3,
                callback_backoff_sec=0,
            ),
            transport=httpx.MockTransport(handler),
        )

        with self.assertRaisesRegex(RuntimeError, "状态码 401"):
            await client.send_batch_item_event({"jobItemId": "item-1", "status": "failed"})

        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
