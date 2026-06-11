from __future__ import annotations

import asyncio
import unittest

from app.config import Settings
from app.models import GeneratedOutput, WorkflowRequest, WorkflowResult
from app.services.orchestration_service import OrchestrationService, WorkflowStore


class FakeProvider:
    def __init__(self) -> None:
        self.calls: list[dict[str, str]] = []

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


if __name__ == "__main__":
    unittest.main()
