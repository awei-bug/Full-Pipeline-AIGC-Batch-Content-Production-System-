from __future__ import annotations

import asyncio
import unittest

from app.config import Settings
from app.models import GeneratedOutput, WorkflowRequest, WorkflowResult
from app.services.orchestration_service import OrchestrationService, WorkflowStore


class FakeProvider:
    def __init__(self) -> None:
        self.calls: list[dict[str, str]] = []
        self.chat_calls: list[list[dict[str, str]]] = []

    async def generate(self, workflow_task_id, payload, on_progress=None):
        self.calls.append(
            {
                "workflow_task_id": workflow_task_id,
                "request_type": payload.request_type,
                "prompt": payload.prompt,
            }
        )
        if on_progress:
            await on_progress(60, "processing", f"external-{workflow_task_id}")
        return WorkflowResult(
            providerCode="modelscope",
            revisedPrompt="refined prompt",
            outputs=[
                GeneratedOutput(
                    assetType="image",
                    storageProvider="local",
                    objectKey="generated/test.png",
                    fileName="test.png",
                    mimeType="image/png",
                    fileSize=128,
                    width=1024,
                    height=1024,
                    metadata={"publicUrl": "/storage/assets/test.png"},
                )
            ],
        )

    async def chat(self, messages):
        self.chat_calls.append(messages)
        return {
            "content": (
                "An 8-second vertical continuous handheld shot in a quiet office. "
                "A commuter gently picks up one matte white cylindrical insulated bottle "
                "with a flat screw lid and stainless rim, rotates it once toward the camera, "
                "then places it beside a laptop. The exact bottle shape, lid, color, material "
                "and proportions remain identical throughout. Soft morning window light, "
                "natural hand movement, premium realistic UGC style, shallow depth of field. "
                "No cuts, text, logo, duplicate object or changing product parts."
            )
        }


class FailingProviderWithCode:
    async def generate(self, workflow_task_id, payload, on_progress=None):
        error = RuntimeError("Agnes 视频下载服务暂时不可用，上游返回 502。")
        error.code = "AGNES_DOWNLOAD_FAILED"
        raise error


class FakeCallbackClient:
    def __init__(self):
        self.events = []

    async def send_task_event(self, payload):
        self.events.append(payload)


class OrchestrationServiceTests(unittest.IsolatedAsyncioTestCase):
    async def _wait_for_terminal_run_state(self, service, workflow_task_id):
        for _ in range(50):
            run_state = service.get_run(workflow_task_id)
            if run_state is not None and run_state.status in {"success", "failed"}:
                return run_state
            await asyncio.sleep(0.02)
        return service.get_run(workflow_task_id)

    async def _wait_for_terminal_content_workflow(self, service, workflow_id):
        for _ in range(50):
            run_state = service.get_content_workflow(workflow_id)
            if run_state is not None and run_state["status"] in {
                "success",
                "partial_success",
                "failed",
            }:
                return run_state
            await asyncio.sleep(0.02)
        return service.get_content_workflow(workflow_id)

    async def test_content_workflow_uses_approved_copy_for_asset_prompt(self):
        settings = Settings(callback_base_url="http://127.0.0.1:3100")
        provider = FakeProvider()
        service = OrchestrationService(
            settings,
            provider=provider,
            callback_client=FakeCallbackClient(),
            store=WorkflowStore(),
        )

        accepted = await service.submit_content_workflow(
            {
                "brief": "帮我宣传这个通勤杯",
                "approvedCopy": "主标题：通勤轻一点\n正文：轻便保温，陪你从早到晚。",
                "copyModel": "agnes-2.5-flash",
                "imageStyles": [
                    {
                        "id": "studio",
                        "label": "产品棚拍",
                        "prompt": "clean product studio",
                    }
                ],
                "videoStyles": [],
            }
        )

        run_state = await self._wait_for_terminal_content_workflow(
            service,
            accepted["id"],
        )

        self.assertIsNotNone(run_state)
        self.assertEqual(run_state["status"], "success")
        self.assertEqual(
            run_state["copy"]["content"],
            "主标题：通勤轻一点\n正文：轻便保温，陪你从早到晚。",
        )
        self.assertEqual(len(provider.calls), 1)
        self.assertIn("主标题：通勤轻一点", provider.calls[0]["prompt"])
        self.assertIn("最终确认宣传文案（最高优先级", provider.calls[0]["prompt"])
        self.assertIn("不得覆盖最终确认文案", provider.calls[0]["prompt"])
        self.assertEqual(run_state["stages"][0]["label"], "使用已确认宣传文案")

    async def test_content_workflow_distills_copy_into_video_generation_prompt(self):
        settings = Settings(callback_base_url="http://127.0.0.1:3100")
        provider = FakeProvider()
        service = OrchestrationService(
            settings,
            provider=provider,
            callback_client=FakeCallbackClient(),
            store=WorkflowStore(),
        )
        approved_copy = (
            "主标题：一杯白色，装下整个清晨。\n"
            "长篇正文和四镜头脚本：闹钟、通勤包、会议室、喝水、产品特写。\n"
            "核心卖点：180克、12小时保温、纯白哑光。"
        )

        accepted = await service.submit_content_workflow(
            {
                "brief": "极简白色保温杯，突出轻便、保温和通勤场景",
                "approvedCopy": approved_copy,
                "copyModel": "agnes-2.5-flash",
                "imageStyles": [],
                "videoStyles": [
                    {
                        "id": "ugc",
                        "label": "真实种草",
                        "prompt": "authentic handheld UGC",
                    }
                ],
            }
        )

        run_state = await self._wait_for_terminal_content_workflow(
            service,
            accepted["id"],
        )

        self.assertIsNotNone(run_state)
        self.assertEqual(run_state["status"], "success")
        self.assertEqual(len(provider.chat_calls), 1)
        self.assertEqual(len(provider.calls), 1)
        video_prompt = provider.calls[0]["prompt"]
        self.assertIn("8-second vertical continuous handheld shot", video_prompt)
        self.assertIn("remain identical throughout", video_prompt)
        self.assertNotIn("四镜头脚本", video_prompt)
        self.assertEqual(
            run_state["videoVariants"][0]["generationPrompt"],
            video_prompt,
        )

    async def test_ip_chapter_workflow_builds_visual_brief_and_narrative_prompt(self):
        settings = Settings(callback_base_url="http://127.0.0.1:3100")
        provider = FakeProvider()
        service = OrchestrationService(
            settings,
            provider=provider,
            callback_client=FakeCallbackClient(),
            store=WorkflowStore(),
        )
        accepted = await service.submit_content_workflow({
            "workflowKind": "ip_chapter",
            "subject": "星港纪事 · 序章",
            "brief": "小雨在封锁中的星港守望航船",
            "approvedCopy": "小雨站在雨夜码头，远处的航船越过封锁线。",
            "imageStyles": [{"id": "cinematic", "label": "电影叙事", "prompt": "cinematic keyframe"}],
            "videoStyles": [],
        })
        run_state = await self._wait_for_terminal_content_workflow(service, accepted["id"])
        self.assertEqual(run_state["status"], "success")
        self.assertEqual(run_state["workflowKind"], "ip_chapter")
        self.assertEqual(run_state["stages"][0]["label"], "提炼视觉开发摘要")
        self.assertEqual(len(provider.chat_calls), 2)
        self.assertIn("视觉开发编辑", provider.chat_calls[0][0]["content"])
        self.assertIn("text-to-image", provider.chat_calls[1][0]["content"])
        self.assertEqual(provider.calls[0]["request_type"], "text_to_image")
        self.assertEqual(run_state["imageVariants"][0]["status"], "success")

    async def test_submit_generation_schedules_background_workflow(self):
        settings = Settings(callback_base_url="http://127.0.0.1:3100")
        provider = FakeProvider()
        callback_client = FakeCallbackClient()
        service = OrchestrationService(
            settings,
            provider=provider,
            callback_client=callback_client,
            store=WorkflowStore(),
        )

        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a launch poster.",
            requestType="text_to_image",
            styleCode="cinematic",
            aspectRatio="9:16",
        )

        accepted = await service.submit_generation(payload)

        self.assertEqual(accepted.status, "created")
        run_state = await self._wait_for_terminal_run_state(
            service,
            accepted.workflow_task_id,
        )
        self.assertIsNotNone(run_state)
        self.assertEqual(run_state.status, "success")
        self.assertEqual(run_state.progress, 100)
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(len(callback_client.events), 1)
        self.assertEqual(callback_client.events[0].status, "succeeded")

    async def test_submit_generation_rejects_invalid_request_before_provider_call(self):
        settings = Settings(callback_base_url="http://127.0.0.1:3100")
        provider = FakeProvider()
        callback_client = FakeCallbackClient()
        service = OrchestrationService(
            settings,
            provider=provider,
            callback_client=callback_client,
            store=WorkflowStore(),
        )

        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_002",
            prompt="   ",
            requestType="text_to_image",
        )

        accepted = await service.submit_generation(payload)

        self.assertEqual(accepted.status, "created")
        run_state = await self._wait_for_terminal_run_state(
            service,
            accepted.workflow_task_id,
        )
        self.assertIsNotNone(run_state)
        self.assertEqual(run_state.status, "failed")
        self.assertEqual(run_state.error_code, "INVALID_WORKFLOW_REQUEST")
        self.assertEqual(len(provider.calls), 0)
        self.assertEqual(len(callback_client.events), 1)
        self.assertEqual(callback_client.events[0].status, "failed")

    async def test_submit_generation_uses_openai_provider_code_for_openai_video(self):
        settings = Settings(
            callback_base_url="http://127.0.0.1:3100",
            video_provider="openai",
        )
        service = OrchestrationService(
            settings,
            provider=FakeProvider(),
            callback_client=FakeCallbackClient(),
            store=WorkflowStore(),
        )
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_003",
            prompt="Generate a short video.",
            requestType="text_to_video",
        )

        accepted = await service.submit_generation(payload)
        run_state = service.get_run(accepted.workflow_task_id)

        self.assertEqual(accepted.provider_code, "openai")
        self.assertIsNotNone(run_state)
        self.assertEqual(run_state.provider_code, "openai")

    async def test_submit_generation_uses_agnes_provider_code_for_image_when_configured(self):
        settings = Settings(
            callback_base_url="http://127.0.0.1:3100",
            image_provider="agnes",
        )
        service = OrchestrationService(
            settings,
            provider=FakeProvider(),
            callback_client=FakeCallbackClient(),
            store=WorkflowStore(),
        )
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_004",
            prompt="Generate an image.",
            requestType="text_to_image",
        )

        accepted = await service.submit_generation(payload)
        run_state = service.get_run(accepted.workflow_task_id)

        self.assertEqual(accepted.provider_code, "agnes")
        self.assertIsNotNone(run_state)
        self.assertEqual(run_state.provider_code, "agnes")

    async def test_submit_generation_preserves_provider_error_code_and_message(self):
        settings = Settings(
            callback_base_url="http://127.0.0.1:3100",
            video_provider="agnes",
        )
        callback_client = FakeCallbackClient()
        service = OrchestrationService(
            settings,
            provider=FailingProviderWithCode(),
            callback_client=callback_client,
            store=WorkflowStore(),
        )
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_005",
            prompt="Generate a short video.",
            requestType="text_to_video",
        )

        accepted = await service.submit_generation(payload)
        run_state = await self._wait_for_terminal_run_state(service, accepted.workflow_task_id)

        self.assertIsNotNone(run_state)
        self.assertEqual(run_state.status, "failed")
        self.assertEqual(run_state.error_code, "AGNES_DOWNLOAD_FAILED")
        self.assertEqual(run_state.error_message, "Agnes 视频下载服务暂时不可用，上游返回 502。")
        self.assertEqual(callback_client.events[0].provider_code, "agnes")
        self.assertEqual(callback_client.events[0].error_code, "AGNES_DOWNLOAD_FAILED")


if __name__ == "__main__":
    unittest.main()
