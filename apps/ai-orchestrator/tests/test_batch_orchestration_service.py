from __future__ import annotations

import asyncio
import unittest

from app.config import Settings
from app.services.orchestration_service import OrchestrationService, WorkflowStore


class FakeBatchProvider:
    async def generate_copy(self, product):
        return {
            "title": f"{product['name']}营销标题",
            "sellingPoints": [product.get("sellingPoint", "核心卖点")],
        }

    async def generate_script(self, product, copy):
        return {
            "script": f"{product['name']}短视频脚本，突出{copy['title']}",
        }

    async def generate_image_prompt(self, product, copy, script):
        return {
            "prompt": f"{product['name']}海报提示词，结合{copy['title']}和{script['script']}",
        }

    async def generate_image_asset(self, workflow_task_id, product, image_prompt):
        return {
            "outputType": "image_asset",
            "outputData": {
                "assetType": "image",
                "storageProvider": "local",
                "objectKey": f"generated/{workflow_task_id}.png",
                "fileName": f"{workflow_task_id}.png",
                "mimeType": "image/png",
                "metadata": {
                    "publicUrl": f"/storage/assets/{workflow_task_id}.png",
                    "prompt": image_prompt["prompt"],
                },
            },
        }


class FakeImageFailureBatchProvider(FakeBatchProvider):
    async def generate_image_asset(self, workflow_task_id, product, image_prompt):
        raise TimeoutError("等待模型结果超时")


class FakeBatchCallbackClient:
    def __init__(self):
        self.batch_events = []

    async def send_batch_item_event(self, payload):
        self.batch_events.append(payload)


class BatchOrchestrationServiceTests(unittest.IsolatedAsyncioTestCase):
    async def _wait_for_terminal_run_state(self, service, workflow_task_id):
        for _ in range(50):
            run_state = service.get_run(workflow_task_id)
            if run_state is not None and run_state.status in {"success", "failed"}:
                return run_state
            await asyncio.sleep(0.02)
        return service.get_run(workflow_task_id)

    async def test_submit_batch_item_returns_created_acceptance(self):
        service = OrchestrationService(
            Settings(callback_base_url="http://127.0.0.1:3100"),
            provider=FakeBatchProvider(),
            callback_client=None,
            store=WorkflowStore(),
        )

        accepted = await service.submit_batch_item(
            {
                "jobItemId": "item_001",
                "jobId": "job_001",
                "productId": "product_001",
                "contentTypes": ["marketing_copy", "video_script", "image_prompt"],
                "productSnapshot": {
                    "id": "product_001",
                    "name": "防晒喷雾",
                    "sellingPoint": "清爽不油腻",
                },
            }
        )

        self.assertEqual(accepted["status"], "created")
        self.assertEqual(accepted["jobItemId"], "item_001")
        self.assertTrue(str(accepted["workflowTaskId"]).startswith("wf_"))

    async def test_submit_batch_item_updates_run_state_to_success(self):
        callback_client = FakeBatchCallbackClient()
        service = OrchestrationService(
            Settings(callback_base_url="http://127.0.0.1:3100"),
            provider=FakeBatchProvider(),
            callback_client=callback_client,
            store=WorkflowStore(),
        )

        accepted = await service.submit_batch_item(
            {
                "jobItemId": "item_002",
                "jobId": "job_001",
                "productId": "product_002",
                "contentTypes": ["marketing_copy", "video_script", "image_prompt"],
                "productSnapshot": {
                    "id": "product_002",
                    "name": "保湿面膜",
                    "sellingPoint": "夜间修护",
                },
            }
        )
        run_state = await self._wait_for_terminal_run_state(
            service,
            accepted["workflowTaskId"],
        )

        self.assertIsNotNone(run_state)
        self.assertEqual(run_state.status, "success")
        self.assertEqual(run_state.progress, 100)
        self.assertEqual(run_state.result_summary["jobItemId"], "item_002")
        self.assertEqual(run_state.result_summary["outputCount"], 4)
        self.assertEqual(len(callback_client.batch_events), 1)
        self.assertEqual(callback_client.batch_events[0]["jobItemId"], "item_002")
        self.assertEqual(callback_client.batch_events[0]["status"], "succeeded")
        self.assertEqual(len(callback_client.batch_events[0]["outputs"]), 4)

    async def test_submit_batch_item_keeps_text_outputs_when_image_generation_fails(self):
        callback_client = FakeBatchCallbackClient()
        service = OrchestrationService(
            Settings(callback_base_url="http://127.0.0.1:3100"),
            provider=FakeImageFailureBatchProvider(),
            callback_client=callback_client,
            store=WorkflowStore(),
        )

        accepted = await service.submit_batch_item(
            {
                "jobItemId": "item_003",
                "jobId": "job_001",
                "productId": "product_003",
                "contentTypes": ["marketing_copy", "video_script", "image_prompt"],
                "productSnapshot": {
                    "id": "product_003",
                    "name": "精华面霜",
                    "sellingPoint": "修护维稳",
                },
            }
        )
        run_state = await self._wait_for_terminal_run_state(
            service,
            accepted["workflowTaskId"],
        )

        self.assertIsNotNone(run_state)
        self.assertEqual(run_state.status, "success")
        self.assertEqual(run_state.result_summary["outputCount"], 3)
        self.assertEqual(len(callback_client.batch_events), 1)
        self.assertEqual(callback_client.batch_events[0]["status"], "succeeded")
        self.assertEqual(len(callback_client.batch_events[0]["outputs"]), 3)
        self.assertEqual(callback_client.batch_events[0]["riskStatus"], "degraded")


if __name__ == "__main__":
    unittest.main()
