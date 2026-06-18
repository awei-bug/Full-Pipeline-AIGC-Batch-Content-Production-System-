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


class FakeTextProvider:
    def __init__(self):
        self.calls = []

    async def generate_copy(self, product):
        self.calls.append(("copy", product))
        return {"title": "真实文案标题", "sellingPoints": ["真实卖点"]}

    async def generate_script(self, product, copy):
        self.calls.append(("script", product, copy))
        return {"script": "真实脚本内容"}

    async def generate_image_prompt(self, product, copy, script):
        self.calls.append(("image_prompt", product, copy, script))
        return {"prompt": "真实提示词内容"}


class GenerationProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_video_uses_agnes_when_configured(self):
        image_provider = FakeProvider("modelscope")
        modelscope_video_provider = FakeProvider("modelscope")
        openai_video_provider = FakeProvider("openai")
        agnes_video_provider = FakeProvider("agnes")
        provider = GenerationProvider(
            Settings(video_provider="agnes"),
            image_provider=image_provider,
            modelscope_video_provider=modelscope_video_provider,
            openai_video_provider=openai_video_provider,
            agnes_video_provider=agnes_video_provider,
        )
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a short video.",
            requestType="text_to_video",
        )

        result = await provider.generate("wf_001", payload)

        self.assertEqual(result.provider_code, "agnes")
        self.assertEqual(agnes_video_provider.calls, [("wf_001", "text_to_video")])
        self.assertEqual(openai_video_provider.calls, [])
        self.assertEqual(modelscope_video_provider.calls, [])

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

    async def test_image_can_use_agnes_provider(self):
        image_provider = FakeProvider("agnes")
        provider = GenerationProvider(
            Settings(image_provider="agnes", video_provider="modelscope"),
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

        self.assertEqual(result.provider_code, "agnes")
        self.assertEqual(image_provider.calls, [("wf_001", "text_to_image")])

    async def test_batch_text_generation_uses_text_provider(self):
        text_provider = FakeTextProvider()
        provider = GenerationProvider(
            Settings(video_provider="openai"),
            image_provider=FakeProvider("modelscope"),
            modelscope_video_provider=FakeProvider("modelscope"),
            openai_video_provider=FakeProvider("openai"),
            text_provider=text_provider,
        )
        product = {
            "id": "product_001",
            "name": "防晒喷雾",
            "sellingPoint": "清爽不油腻",
        }

        copy = await provider.generate_copy(product)
        script = await provider.generate_script(product, copy)
        prompt = await provider.generate_image_prompt(product, copy, script)

        self.assertEqual(copy["title"], "真实文案标题")
        self.assertEqual(script["script"], "真实脚本内容")
        self.assertEqual(prompt["prompt"], "真实提示词内容")
        self.assertEqual(text_provider.calls[0][0], "copy")
        self.assertEqual(text_provider.calls[1][0], "script")
        self.assertEqual(text_provider.calls[2][0], "image_prompt")


if __name__ == "__main__":
    unittest.main()
