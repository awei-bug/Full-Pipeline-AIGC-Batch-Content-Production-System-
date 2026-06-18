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
                self.assertEqual(body["model"], "agnes-image-2.1-flash")
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

    async def test_generate_video_uses_openai_compatible_agnes_endpoints(self):
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.method == "POST" and request.url.path == "/v1/videos":
                body = json.loads(request.content.decode("utf-8"))
                self.assertEqual(body["model"], "agnes-video-v2.0")
                self.assertEqual(body["seconds"], "8")
                return httpx.Response(200, json={"id": "video_001", "status": "queued"})
            if request.method == "GET" and request.url.path == "/v1/videos/video_001":
                return httpx.Response(200, json={"id": "video_001", "status": "completed"})
            if request.method == "GET" and request.url.path == "/v1/videos/video_001/content":
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
            self.assertEqual((Path(temp_dir) / "wf_001.mp4").read_bytes(), b"fake-video")
            self.assertEqual(requests[0].headers["authorization"], "Bearer agnes-token")

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

    async def test_download_video_retries_gateway_html_failures_three_times(self):
        attempts = {"download_count": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path == "/v1/videos":
                return httpx.Response(200, json={"id": "video_001", "status": "queued"})
            if request.method == "GET" and request.url.path == "/v1/videos/video_001":
                return httpx.Response(200, json={"id": "video_001", "status": "completed"})
            if request.method == "GET" and request.url.path == "/v1/videos/video_001/content":
                attempts["download_count"] += 1
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
        self.assertIn("Agnes 视频下载服务暂时不可用", str(error.exception))
        self.assertEqual(attempts["download_count"], 3)


if __name__ == "__main__":
    unittest.main()
