from __future__ import annotations

import unittest
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx

from app.config import Settings
from app.models import WorkflowRequest
from app.providers.openai_video import (
    OpenAIVideoError,
    OpenAIVideoProvider,
    aspect_to_openai_video_size,
)


class OpenAIVideoProviderTests(unittest.IsolatedAsyncioTestCase):
    def test_aspect_ratio_maps_to_openai_video_size(self):
        self.assertEqual(aspect_to_openai_video_size("16:9"), "1280x720")
        self.assertEqual(aspect_to_openai_video_size("9:16"), "720x1280")
        self.assertEqual(aspect_to_openai_video_size("1:1"), "1024x1024")

    async def test_generate_creates_polls_and_downloads_video(self):
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.method == "POST" and request.url.path == "/v1/videos":
                return httpx.Response(
                    200,
                    json={"id": "video_001", "status": "queued"},
                )
            if request.method == "GET" and request.url.path == "/v1/videos/video_001":
                return httpx.Response(
                    200,
                    json={"id": "video_001", "status": "completed"},
                )
            if (
                request.method == "GET"
                and request.url.path == "/v1/videos/video_001/content"
            ):
                return httpx.Response(
                    200,
                    content=b"fake-mp4",
                    headers={"content-type": "video/mp4"},
                )
            return httpx.Response(404, json={"error": {"message": "not found"}})

        with TemporaryDirectory() as temp_dir:
            settings = Settings(
                openai_api_key="openai-token",
                assets_dir=Path(temp_dir),
                video_poll_interval_sec=0,
                video_max_attempts=2,
            )
            provider = OpenAIVideoProvider(
                settings,
                transport=httpx.MockTransport(handler),
                sleep=lambda _seconds: None,
            )
            payload = WorkflowRequest(
                projectId="project_001",
                creationRequestId="cr_001",
                taskId="task_001",
                prompt="Generate a short city video.",
                requestType="text_to_video",
                aspectRatio="16:9",
                durationSec=8,
            )

            result = await provider.generate("wf_001", payload)

            self.assertEqual(result.provider_code, "openai")
            self.assertEqual(result.outputs[0].asset_type, "video")
            self.assertEqual(result.outputs[0].file_name, "wf_001.mp4")
            self.assertEqual(result.outputs[0].file_size, 8)
            self.assertEqual(result.outputs[0].metadata["sourceVideoId"], "video_001")
            self.assertEqual((Path(temp_dir) / "wf_001.mp4").read_bytes(), b"fake-mp4")

        create_body = json.loads(requests[0].read().decode("utf-8"))
        self.assertEqual(create_body["model"], "sora-2")
        self.assertEqual(create_body["size"], "1280x720")
        self.assertEqual(create_body["seconds"], 8)
        self.assertEqual(requests[0].headers["authorization"], "Bearer openai-token")

    async def test_generate_requires_openai_api_key(self):
        settings = Settings(openai_api_key=None)
        provider = OpenAIVideoProvider(settings)
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a short video.",
            requestType="text_to_video",
        )

        with self.assertRaises(OpenAIVideoError) as error:
            await provider.generate("wf_001", payload)

        self.assertEqual(error.exception.code, "OPENAI_TOKEN_MISSING")


if __name__ == "__main__":
    unittest.main()
