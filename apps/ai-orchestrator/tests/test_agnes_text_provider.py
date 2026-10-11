from __future__ import annotations

import json
import unittest

import httpx

from app.config import Settings
from app.providers.agnes_text import AgnesTextProvider


class AgnesTextProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_generate_copy_uses_agnes_chat_completions_endpoint(self):
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            self.assertEqual(request.url.path, "/v1/chat/completions")
            payload = json.loads(request.content.decode("utf-8"))
            self.assertEqual(payload["model"], "agnes-2.5-flash")
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": '{"title":"夏季清爽防晒喷雾","sellingPoints":["清爽不油腻"],"body":"通勤场景轻松补喷。"}'
                            }
                        }
                    ]
                },
            )

        provider = AgnesTextProvider(
            Settings(
                agnes_api_key="agnes-token",
                agnes_base_url="https://apihub.agnes-ai.com/v1",
            ),
            transport=httpx.MockTransport(handler),
        )

        result = await provider.generate_copy(
            {
                "name": "防晒喷雾",
                "sellingPoint": "清爽不油腻",
            }
        )

        self.assertEqual(result["title"], "夏季清爽防晒喷雾")
        self.assertEqual(result["sellingPoints"][0], "清爽不油腻")
        self.assertEqual(result["generationMeta"]["source"], "agnes_text")
        self.assertFalse(result["generationMeta"]["fallbackUsed"])
        self.assertEqual(
            requests[0].headers["authorization"],
            "Bearer agnes-token",
        )


if __name__ == "__main__":
    unittest.main()
