from __future__ import annotations

import unittest

from app.graphs.batch_generation_graph import build_batch_generation_graph
from app.graphs.batch_generation_state import build_initial_batch_state


class FakeBatchProvider:
    async def generate_copy(self, product):
        return {
            "title": f"{product['name']}爆款标题",
            "sellingPoints": [product.get("sellingPoint", "核心卖点")],
            "generationMeta": {
                "source": "modelscope_text",
                "fallbackUsed": False,
                "reason": None,
                "model": "Qwen/Qwen2.5-7B-Instruct",
            },
        }

    async def generate_script(self, product, copy):
        return {
            "script": f"{product['name']}短视频脚本：{copy['title']}",
            "generationMeta": {
                "source": "fallback",
                "fallbackUsed": True,
                "reason": "invalid_json_response",
                "model": "Qwen/Qwen2.5-7B-Instruct",
            },
        }

    async def generate_image_prompt(self, product, copy, script):
        return {
            "prompt": f"{product['name']}海报提示词，突出{copy['title']}，结合{script['script']}",
            "generationMeta": {
                "source": "modelscope_text",
                "fallbackUsed": False,
                "reason": None,
                "model": "Qwen/Qwen2.5-7B-Instruct",
            },
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
                "width": 1024,
                "height": 1024,
                "metadata": {
                    "publicUrl": f"/storage/assets/{workflow_task_id}.png",
                    "prompt": image_prompt["prompt"],
                },
            },
        }

    async def generate_video_asset(self, workflow_task_id, product, script):
        return {
            "outputType": "video_asset",
            "outputData": {
                "assetType": "video",
                "storageProvider": "local",
                "objectKey": f"generated/{workflow_task_id}.mp4",
                "fileName": f"{workflow_task_id}.mp4",
                "mimeType": "video/mp4",
                "durationSec": 8,
                "metadata": {
                    "publicUrl": f"/storage/assets/{workflow_task_id}.mp4",
                    "prompt": script["script"],
                },
            },
        }


class BatchGenerationGraphTests(unittest.IsolatedAsyncioTestCase):
    async def test_batch_graph_generates_copy_script_and_image_prompt(self):
        graph = build_batch_generation_graph(FakeBatchProvider())
        state = build_initial_batch_state(
            workflow_task_id="wf_batch_001",
            job_item={
                "jobItemId": "item_001",
                "jobId": "job_001",
                "productId": "product_001",
                "contentTypes": ["marketing_copy", "video_script", "image_prompt"],
                "productSnapshot": {
                    "id": "product_001",
                    "name": "防晒喷雾",
                    "sellingPoint": "清爽不油腻",
                },
            },
        )

        result = await graph.ainvoke(state)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["copy"]["title"], "防晒喷雾爆款标题")
        self.assertIn("短视频脚本", result["script"]["script"])
        self.assertIn("海报提示词", result["image_prompt"]["prompt"])
        self.assertEqual(len(result["outputs"]), 4)
        self.assertEqual(result["outputs"][-1]["outputType"], "image_asset")
        self.assertEqual(
            result["outputs"][-1]["outputData"]["metadata"]["publicUrl"],
            "/storage/assets/wf_batch_001.png",
        )

    async def test_batch_graph_outputs_keep_generation_meta(self):
        graph = build_batch_generation_graph(FakeBatchProvider())
        state = build_initial_batch_state(
            workflow_task_id="wf_batch_002",
            job_item={
                "jobItemId": "item_002",
                "jobId": "job_002",
                "productId": "product_002",
                "contentTypes": ["marketing_copy", "video_script", "image_prompt"],
                "productSnapshot": {
                    "id": "product_002",
                    "name": "保湿面膜",
                    "sellingPoint": "夜间修护",
                },
            },
        )

        result = await graph.ainvoke(state)
        output_by_type = {
            item["outputType"]: item["outputData"]
            for item in result["outputs"]
            if item["outputType"] != "image_asset"
        }

        self.assertEqual(output_by_type["marketing_copy"]["generationMeta"]["source"], "modelscope_text")
        self.assertFalse(output_by_type["marketing_copy"]["generationMeta"]["fallbackUsed"])
        self.assertEqual(output_by_type["video_script"]["generationMeta"]["source"], "fallback")
        self.assertTrue(output_by_type["video_script"]["generationMeta"]["fallbackUsed"])
        self.assertEqual(output_by_type["video_script"]["generationMeta"]["reason"], "invalid_json_response")
        self.assertEqual(output_by_type["image_prompt"]["generationMeta"]["model"], "Qwen/Qwen2.5-7B-Instruct")

    async def test_batch_graph_generates_video_from_generated_script(self):
        graph = build_batch_generation_graph(FakeBatchProvider())
        state = build_initial_batch_state(
            workflow_task_id="wf_batch_video_001",
            job_item={
                "jobItemId": "item_video_001",
                "jobId": "job_video_001",
                "productId": "product_video_001",
                "contentTypes": ["marketing_copy", "video_asset"],
                "productSnapshot": {
                    "id": "product_video_001",
                    "name": "工业连接器",
                    "sellingPoint": "高防护等级",
                },
            },
        )

        result = await graph.ainvoke(state)
        output_types = [item["outputType"] for item in result["outputs"]]

        self.assertEqual(output_types, ["marketing_copy", "video_asset"])
        self.assertEqual(
            result["outputs"][-1]["outputData"]["metadata"]["publicUrl"],
            "/storage/assets/wf_batch_video_001.mp4",
        )

    async def test_batch_graph_respects_selected_content_types(self):
        graph = build_batch_generation_graph(FakeBatchProvider())
        state = build_initial_batch_state(
            workflow_task_id="wf_batch_003",
            job_item={
                "jobItemId": "item_003",
                "jobId": "job_003",
                "productId": "product_003",
                "contentTypes": ["marketing_copy"],
                "productSnapshot": {
                    "id": "product_003",
                    "name": "工业连接器",
                    "sellingPoint": "高防护等级",
                },
            },
        )

        result = await graph.ainvoke(state)
        output_types = [item["outputType"] for item in result["outputs"]]

        self.assertEqual(result["status"], "success")
        self.assertEqual(output_types, ["marketing_copy"])
        self.assertIsNotNone(result["copy"])
        self.assertIsNone(result["script"])
        self.assertIsNone(result["image_prompt"])


if __name__ == "__main__":
    unittest.main()
