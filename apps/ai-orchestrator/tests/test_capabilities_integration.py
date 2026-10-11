import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path

from app.ip_content.router import LLMRouter
from app.ip_content.service import (
    BatchRequest,
    IPContentService,
    MemoryStore,
    ProjectRequest,
)
from app.storage import LocalObjectStore

STAGE_TOKENS = {"research": "调研员", "draft": "编剧", "polish": "叙事编辑", "review": "审核员"}


class _FullRouter:
    """覆盖阶段路由 + 提示词优化工程师 + 安全审核员，便于端到端验证增强层。"""

    OVERRIDES = {
        "researcher": "调研员（优化版）", "writer": "编剧（优化版）",
        "editor": "编辑（优化版）", "critic": "审核员（优化版）",
    }

    def __init__(self):
        self.calls: list[str] = []

    MODEL = "agnes-2.5-flash"  # 命中内置单价表，保证成本核算非零可断言

    async def complete(self, messages, tools=None, **_kwargs):
        system = messages[0]["content"]
        self.calls.append(system[:12])
        if "提示词优化工程师" in system:
            return {"message": {"content": json.dumps(self.OVERRIDES, ensure_ascii=False)},
                    "usage": {"total_tokens": 9}, "model": self.MODEL}
        if "内容安全审核员" in system:
            return {"message": {"content": "PASS\n依据：内容合规"}, "usage": {}, "model": self.MODEL}
        stage = next(k for k, t in STAGE_TOKENS.items() if t in system)
        if stage == "review":
            return {"message": {"content": "PASS\n依据：设定一致，前章衔接合理"},
                    "usage": {"total_tokens": 5}, "model": self.MODEL}
        return {"message": {"content": f"{stage} 内容"}, "usage": {"total_tokens": 5}, "model": self.MODEL}


class CapabilitiesIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_item_persists_eval_safety_cost_and_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            router = _FullRouter()
            service = IPContentService(
                router, enable_agent_team=True, object_store=LocalObjectStore(Path(tmp)),
                eval_enabled=True, safety_llm_enabled=False,
            )
            batch = await service.submit(BatchRequest.model_validate({
                "ipName": "星港", "lore": "角色不能离开港口",
                "chapters": [{"title": "序章", "brief": "介绍港口"}],
            }))
            await service.run_item(batch["id"], batch["items"][0]["id"])
            result = (await service.get_batch(batch["id"]))["items"][0]
            r = result["result"]
            self.assertIsNotNone(r["evalReport"])
            self.assertIsNotNone(r["safety"])
            self.assertIsNotNone(r["cost"])
            self.assertIsNotNone(r["objectKey"])
            self.assertTrue(r["safety"]["passed"])
            self.assertFalse(r["safetyHold"])
            # 对象存储落盘
            path = os.path.join(tmp, *r["objectKey"].split("/"))
            self.assertTrue(os.path.exists(path))
            saved = json.loads(Path(path).read_text(encoding="utf-8"))
            self.assertIn("evalReport", saved)
            # 批次成本汇总
            summary = (await service.get_batch(batch["id"]))["costSummary"]
            self.assertGreaterEqual(summary["chaptersCounted"], 1)
            self.assertGreater(summary["totalCost"], 0)

    async def test_prompt_optimization_loop_persists_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            router = _FullRouter()
            service = IPContentService(
                router, enable_agent_team=True, object_store=LocalObjectStore(Path(tmp)),
                eval_enabled=True, prompt_opt_enabled=True, safety_llm_enabled=False,
            )
            project = await service.save_project(ProjectRequest.model_validate({
                "name": "星港", "lore": "角色不能离开港口",
            }))
            batch = await service.submit(BatchRequest.model_validate({
                "ipName": "星港", "projectId": project["id"],
                "chapters": [{"title": "序章", "brief": "介绍港口"}],
            }))
            await service.run_item(batch["id"], batch["items"][0]["id"])
            # 短桩内容评测不通过 → 优化器改写并持久化 promptProfile
            profile = await service.store.get(f"promptProfile:{project['id']}")
            self.assertIsNotNone(profile, "提示词自优化应持久化 promptProfile")
            self.assertEqual(set(profile["overrides"]), {"researcher", "writer", "editor", "critic"})
            # 后续同库章节应加载该覆盖
            loaded = await service.optimizer.load_overrides(project["id"])
            self.assertEqual(loaded, profile["overrides"])

    async def test_real_router_reused_when_unconfigured(self):
        # 复用 LLMRouter 验证增强层不绕过既有路由（无密钥报错由 run_item 捕获为 failed）。
        service = IPContentService(LLMRouter([]), enable_agent_team=True,
                                    eval_enabled=True, safety_llm_enabled=False)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "canon",
            "chapters": [{"title": "序章", "brief": "开场"}],
        }))
        await service.run_item(batch["id"], batch["items"][0]["id"])
        result = (await service.get_batch(batch["id"]))["items"][0]
        self.assertEqual(result["status"], "failed")


if __name__ == "__main__":
    unittest.main()
