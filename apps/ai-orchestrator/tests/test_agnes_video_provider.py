from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx

from app.config import Settings
from app.models import WorkflowRequest
from app.providers.agnes import AgnesError, AgnesProvider


class AgnesProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_generate_image_uses_openai_compatible_image_endpoint(self):
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.method == "POST" and request.url.path == "/v1/images/generations":
                body = json.loads(request.content.decode("utf-8"))
                self.assertEqual(body["model"], "agnes-image-2.5-flash")
                self.assertEqual(body["size"], "1K")
                self.assertEqual(body["ratio"], "1:1")
                self.assertEqual(body["extra_body"]["response_format"], "url")
                return httpx.Response(
                    200,
                    json={"data": [{"url": "https://cdn.example.com/generated.png"}]},
                )
            if request.method == "GET" and request.url.path == "/generated.png":
                return httpx.Response(
                    200,
                    content=b"fake-image",
                    headers={"content-type": "image/png"},
                )
            return httpx.Response(404, json={"error": {"message": "not found"}})

        with TemporaryDirectory() as temp_dir:
            provider = AgnesProvider(
                Settings(
                    agnes_api_key="agnes-token",
                    agnes_base_url="https://apihub.agnes-ai.com/v1",
                    assets_dir=Path(temp_dir),
                ),
                transport=httpx.MockTransport(handler),
                sleep=lambda _seconds: None,
            )
            payload = WorkflowRequest(
                projectId="project_001",
                creationRequestId="cr_001",
                taskId="task_001",
                prompt="Generate a poster.",
                requestType="text_to_image",
                aspectRatio="1:1",
            )

            result = await provider.generate("wf_001", payload)

            self.assertEqual(result.provider_code, "agnes")
            self.assertEqual(result.outputs[0].file_name, "wf_001.png")
            self.assertEqual((Path(temp_dir) / "wf_001.png").read_bytes(), b"fake-image")

    async def test_generate_image_retries_transient_disconnects(self):
        attempts = {"count": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path == "/v1/images/generations":
                attempts["count"] += 1
                if attempts["count"] < 3:
                    raise httpx.RemoteProtocolError(
                        "Server disconnected without sending a response.",
                        request=request,
                    )
                return httpx.Response(
                    200,
                    json={"data": [{"url": "https://cdn.example.com/generated.png"}]},
                )
            if request.method == "GET" and request.url.path == "/generated.png":
                return httpx.Response(200, content=b"fake-image")
            return httpx.Response(404)

        with TemporaryDirectory() as temp_dir:
            provider = AgnesProvider(
                Settings(
                    agnes_api_key="agnes-token",
                    agnes_base_url="https://apihub.agnes-ai.com/v1",
                    assets_dir=Path(temp_dir),
                ),
                transport=httpx.MockTransport(handler),
                sleep=lambda _seconds: None,
            )
            payload = WorkflowRequest(
                projectId="project_001",
                creationRequestId="cr_001",
                taskId="task_001",
                prompt="Generate a poster.",
                requestType="text_to_image",
                aspectRatio="1:1",
            )

            result = await provider.generate("wf_retry", payload)

            self.assertEqual(attempts["count"], 3)
            self.assertEqual(result.outputs[0].file_name, "wf_retry.png")

    async def test_generate_video_uses_openai_compatible_agnes_endpoints(self):
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.method == "POST" and request.url.path == "/v1/videos":
                body = json.loads(request.content.decode("utf-8"))
                self.assertEqual(body["model"], "agnes-video-v2.0")
                self.assertEqual(body["width"], 1280)
                self.assertEqual(body["height"], 720)
                self.assertEqual(body["num_frames"], 193)
                self.assertEqual(body["frame_rate"], 24)
                self.assertIn("morphing product", body["negative_prompt"])
                self.assertIn("unreadable text", body["negative_prompt"])
                self.assertNotIn("seconds", body)
                self.assertNotIn("size", body)
                self.assertNotIn("aspect_ratio", body)
                return httpx.Response(200, json={"id": "task_001", "video_id": "video_001", "status": "queued"})
            if request.method == "GET" and request.url.path == "/agnesapi":
                self.assertEqual(request.url.params["video_id"], "video_001")
                self.assertEqual(request.url.params["model_name"], "agnes-video-v2.0")
                return httpx.Response(
                    200,
                    json={
                        "id": "task_001",
                        "video_id": "video_001",
                        "status": "completed",
                        "metadata": {"url": "https://cdn.example.com/generated.mp4"},
                    },
                )
            if request.method == "GET" and request.url.path == "/generated.mp4":
                return httpx.Response(
                    200,
                    content=b"fake-video",
                    headers={"content-type": "video/mp4"},
                )
            return httpx.Response(404, json={"error": {"message": "not found"}})

        with TemporaryDirectory() as temp_dir:
            provider = AgnesProvider(
                Settings(
                    agnes_api_key="agnes-token",
                    agnes_base_url="https://apihub.agnes-ai.com/v1",
                    assets_dir=Path(temp_dir),
                    video_poll_interval_sec=0,
                    video_max_attempts=2,
                ),
                transport=httpx.MockTransport(handler),
                sleep=lambda _seconds: None,
            )
            payload = WorkflowRequest(
                projectId="project_001",
                creationRequestId="cr_001",
                taskId="task_001",
                prompt="Generate a city video.",
                requestType="text_to_video",
                aspectRatio="16:9",
                durationSec=8,
            )

            result = await provider.generate("wf_001", payload)

            self.assertEqual(result.provider_code, "agnes")
            self.assertEqual(result.outputs[0].file_name, "wf_001.mp4")
            self.assertEqual(result.outputs[0].width, 1280)
            self.assertEqual(result.outputs[0].height, 720)
            self.assertEqual(result.outputs[0].metadata["numFrames"], 193)
            self.assertEqual((Path(temp_dir) / "wf_001.mp4").read_bytes(), b"fake-video")
            self.assertEqual(requests[0].headers["authorization"], "Bearer agnes-token")

    async def test_generate_video_keeps_polling_while_status_is_pending(self):
        poll_count = {"value": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path == "/v1/videos":
                body = json.loads(request.content.decode("utf-8"))
                self.assertEqual(body["width"], 720)
                self.assertEqual(body["height"], 1280)
                return httpx.Response(200, json={"video_id": "video_001", "status": "pending"})
            if request.method == "GET" and request.url.path == "/agnesapi":
                poll_count["value"] += 1
                if poll_count["value"] == 1:
                    return httpx.Response(200, json={"video_id": "video_001", "status": "pending"})
                return httpx.Response(
                    200,
                    json={
                        "video_id": "video_001",
                        "status": "completed",
                        "metadata": {"url": "https://cdn.example.com/generated.mp4"},
                    },
                )
            if request.method == "GET" and request.url.path == "/generated.mp4":
                return httpx.Response(200, content=b"fake-video")
            return httpx.Response(404)

        with TemporaryDirectory() as temp_dir:
            provider = AgnesProvider(
                Settings(
                    agnes_api_key="agnes-token",
                    agnes_base_url="https://apihub.agnes-ai.com/v1",
                    assets_dir=Path(temp_dir),
                    video_poll_interval_sec=0,
                    video_max_attempts=3,
                ),
                transport=httpx.MockTransport(handler),
                sleep=lambda _seconds: None,
            )
            payload = WorkflowRequest(
                projectId="project_001",
                creationRequestId="cr_001",
                taskId="task_001",
                prompt="Generate a city video.",
                requestType="text_to_video",
                aspectRatio="9:16",
                durationSec=8,
            )

            result = await provider.generate("wf_pending", payload)

            self.assertEqual(result.outputs[0].file_name, "wf_pending.mp4")
            self.assertEqual(poll_count["value"], 2)

    async def test_generate_video_normalizes_free_user_rate_limit_error(self):
        upstream_message = (
            "You've reached the API rate limit for free users. "
            "Upgrade to a Token Plan to unlock higher limits. "
            "(request id: 20260909105710227893553MuDPvCK8)"
        )

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path == "/v1/videos":
                return httpx.Response(429, json={"error": {"message": upstream_message}})
            return httpx.Response(404)

        provider = AgnesProvider(
            Settings(
                agnes_api_key="agnes-token",
                agnes_base_url="https://apihub.agnes-ai.com/v1",
            ),
            transport=httpx.MockTransport(handler),
            sleep=lambda _seconds: None,
        )
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a city video.",
            requestType="text_to_video",
            aspectRatio="16:9",
            durationSec=8,
        )

        with self.assertRaises(AgnesError) as error:
            await provider.generate("wf_rate_limited", payload)

        self.assertEqual(error.exception.code, "AGNES_RATE_LIMITED")
        self.assertEqual(
            str(error.exception),
            "Agnes 免费额度已用完，请升级套餐或更换有额度的 API Key。",
        )
        self.assertEqual(error.exception.details["error"]["message"], upstream_message)
        self.assertNotIn("request id", str(error.exception).lower())

    async def test_generate_video_retries_gateway_html_failures_three_times(self):
        attempts = {"count": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path == "/v1/videos":
                attempts["count"] += 1
                return httpx.Response(
                    502,
                    text="<!DOCTYPE html><html><body>Bad gateway</body></html>",
                    headers={"content-type": "text/html"},
                )
            return httpx.Response(404)

        provider = AgnesProvider(
            Settings(
                agnes_api_key="agnes-token",
                agnes_base_url="https://apihub.agnes-ai.com/v1",
            ),
            transport=httpx.MockTransport(handler),
            sleep=lambda _seconds: None,
        )
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a city video.",
            requestType="text_to_video",
            aspectRatio="16:9",
            durationSec=8,
        )

        with self.assertRaises(AgnesError) as error:
            await provider.generate("wf_001", payload)

        self.assertEqual(error.exception.code, "AGNES_VIDEO_FAILED")
        self.assertIn("Agnes 视频服务暂时不可用", str(error.exception))
        self.assertEqual(attempts["count"], 3)

    async def test_generate_video_requires_result_url(self):

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path == "/v1/videos":
                return httpx.Response(200, json={"id": "task_001", "video_id": "video_001", "status": "queued"})
            if request.method == "GET" and request.url.path == "/agnesapi":
                return httpx.Response(200, json={"id": "video_001", "status": "completed"})
            return httpx.Response(404)

        provider = AgnesProvider(
            Settings(
                agnes_api_key="agnes-token",
                agnes_base_url="https://apihub.agnes-ai.com/v1",
                video_poll_interval_sec=0,
                video_max_attempts=2,
            ),
            transport=httpx.MockTransport(handler),
            sleep=lambda _seconds: None,
        )
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a city video.",
            requestType="text_to_video",
            aspectRatio="16:9",
            durationSec=8,
        )

        with self.assertRaises(AgnesError) as error:
            await provider.generate("wf_001", payload)

        self.assertEqual(error.exception.code, "AGNES_DOWNLOAD_FAILED")
        self.assertIn("metadata.url", str(error.exception))


if __name__ == "__main__":
    unittest.main()
