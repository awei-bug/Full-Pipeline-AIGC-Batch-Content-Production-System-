from __future__ import annotations

import unittest

from app.config import Settings
from app.models import WorkflowRequest, WorkflowResult
from app.providers.generation_provider import GenerationProvider


class FakeProvider:
    def __init__(self, provider_code: str):
        self.provider_code = provider_code
        self.calls = []

    async def generate(self, workflow_task_id, payload, on_progress=None):
        self.calls.append((workflow_task_id, payload.request_type))
        return WorkflowResult(providerCode=self.provider_code, outputs=[])


class GenerationProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_video_uses_openai_when_configured(self):
        image_provider = FakeProvider("modelscope")
        modelscope_video_provider = FakeProvider("modelscope")
        openai_video_provider = FakeProvider("openai")
        provider = GenerationProvider(
            Settings(video_provider="openai"),
            image_provider=image_provider,
            modelscope_video_provider=modelscope_video_provider,
            openai_video_provider=openai_video_provider,
        )
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a short video.",
            requestType="text_to_video",
        )

        result = await provider.generate("wf_001", payload)

        self.assertEqual(result.provider_code, "openai")
        self.assertEqual(openai_video_provider.calls, [("wf_001", "text_to_video")])
        self.assertEqual(modelscope_video_provider.calls, [])

    async def test_image_always_uses_image_provider(self):
        image_provider = FakeProvider("modelscope")
        provider = GenerationProvider(
            Settings(video_provider="openai"),
            image_provider=image_provider,
            modelscope_video_provider=FakeProvider("modelscope"),
            openai_video_provider=FakeProvider("openai"),
        )
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a poster.",
            requestType="text_to_image",
        )

        result = await provider.generate("wf_001", payload)

        self.assertEqual(result.provider_code, "modelscope")
        self.assertEqual(image_provider.calls, [("wf_001", "text_to_image")])


if __name__ == "__main__":
    unittest.main()
