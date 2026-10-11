from __future__ import annotations

import json
import unittest

import httpx

from app.config import Settings
from app.providers.modelscope_text import ModelScopeTextProvider


class ModelScopeTextProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_forwards_messages_and_returns_plain_text(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/v1/chat/completions")
            payload = json.loads(request.content.decode("utf-8"))
            self.assertEqual(payload["model"], "Qwen/Qwen2.5-7B-Instruct")
            self.assertEqual(
                payload["messages"],
                [
                    {"role": "system", "content": "你是宣传文案助手。"},
                    {"role": "user", "content": "帮我宣传一款通勤杯。"},
                ],
            )
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": "主标题：通勤轻一点\n正文：从清晨热饮到傍晚通勤，一杯陪到底。",
                            }
                        }
                    ]
                },
            )

        provider = ModelScopeTextProvider(
            Settings(
                modelscope_api_token="token",
                modelscope_base_url="https://mocked.example.com/v1",
                callback_base_url="http://127.0.0.1:3100",
            ),
            transport=httpx.MockTransport(handler),
        )

        result = await provider.chat(
            [
                {"role": "system", "content": "你是宣传文案助手。"},
                {"role": "user", "content": "帮我宣传一款通勤杯。"},
            ]
        )

        self.assertIn("通勤轻一点", result["content"])
        self.assertEqual(result["model"], "Qwen/Qwen2.5-7B-Instruct")
        self.assertEqual(result["provider"], "modelscope")

    async def test_generate_copy_parses_json_code_block_response(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/v1/chat/completions")
            payload = json.loads(request.content.decode("utf-8"))
            self.assertEqual(payload["model"], "Qwen/Qwen2.5-7B-Instruct")
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": """```json
{"title":"夏季清爽防晒喷雾","sellingPoints":["清爽不油腻"],"body":"通勤场景轻松补喷。"}
```"""
                            }
                        }
                    ]
                },
            )

        provider = ModelScopeTextProvider(
            Settings(
                modelscope_api_token="token",
                modelscope_base_url="https://mocked.example.com/v1",
                callback_base_url="http://127.0.0.1:3100",
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
        self.assertEqual(result["generationMeta"]["source"], "modelscope_text")
        self.assertFalse(result["generationMeta"]["fallbackUsed"])

    async def test_generate_script_falls_back_to_structured_default_when_response_is_not_json(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": "这是一段普通文本，不是 JSON",
                            }
                        }
                    ]
                },
            )

        provider = ModelScopeTextProvider(
            Settings(
                modelscope_api_token="token",
                modelscope_base_url="https://mocked.example.com/v1",
                callback_base_url="http://127.0.0.1:3100",
            ),
            transport=httpx.MockTransport(handler),
        )

        result = await provider.generate_script(
            {"name": "防晒喷雾"},
            {"title": "夏季清爽防晒喷雾"},
        )

        self.assertIn("script", result)
        self.assertIn("防晒喷雾", result["script"])
        self.assertEqual(result["generationMeta"]["source"], "fallback")
        self.assertTrue(result["generationMeta"]["fallbackUsed"])
        self.assertEqual(result["generationMeta"]["reason"], "invalid_json_response")

    async def test_generate_image_prompt_uses_configured_text_model(self):
        observed_model = {"value": None}

        def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content.decode("utf-8"))
            observed_model["value"] = payload["model"]
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": '{"prompt":"高级感商品海报提示词"}',
                            }
                        }
                    ]
                },
            )

        provider = ModelScopeTextProvider(
            Settings(
                modelscope_api_token="token",
                modelscope_base_url="https://mocked.example.com/v1",
                callback_base_url="http://127.0.0.1:3100",
                modelscope_text_model="Qwen/Qwen2.5-7B-Instruct",
            ),
            transport=httpx.MockTransport(handler),
        )

        result = await provider.generate_image_prompt(
            {"name": "防晒喷雾"},
            {"title": "夏季清爽防晒喷雾"},
            {"script": "先展示产品，再强调卖点"},
        )

        self.assertEqual(observed_model["value"], "Qwen/Qwen2.5-7B-Instruct")
        self.assertEqual(result["prompt"], "高级感商品海报提示词")
        self.assertEqual(result["generationMeta"]["model"], "Qwen/Qwen2.5-7B-Instruct")


if __name__ == "__main__":
    unittest.main()
