import asyncio
import unittest

from app.ip_content.router import LLMRouter
from app.ip_content.service import (
    BatchRequest,
    IPContentService,
    MemoryStore,
)

STAGE_TOKENS = {"research": "调研员", "draft": "编剧", "polish": "叙事编辑", "review": "审核员"}


class FakeRouter:
    """不联网的桩路由：按 system prompt 识别阶段，可按需让审核失败若干次。"""

    def __init__(self, fail_review_times: int = 0):
        self.calls: list[tuple[str, str, bool]] = []
        self.fail_review_times = fail_review_times
        self._failures = 0

    async def complete(self, messages, tools=None, **_kwargs):
        system = messages[0]["content"]
        stage = next(key for key, token in STAGE_TOKENS.items() if token in system)
        self.calls.append((stage, messages[1]["content"], bool(tools)))
        if stage == "review":
            if self._failures < self.fail_review_times:
                self._failures += 1
                return {"message": {"content": "FAIL\n依据：人物行动与设定冲突，需保持角色在港口"},
                        "usage": {"total_tokens": 5}, "model": "test-model"}
            return {"message": {"content": "PASS\n依据：设定一致，前章事实衔接合理"},
                    "usage": {"total_tokens": 5}, "model": "test-model"}
        return {"message": {"content": f"{stage} 内容"}, "usage": {"total_tokens": 5}, "model": "test-model"}


class AgentTeamTests(unittest.IsolatedAsyncioTestCase):
    async def test_team_passes_through_with_full_collaboration(self):
        service = IPContentService(FakeRouter(), enable_agent_team=True, max_self_revisions=3)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "角色A不能离开港口",
            "chapters": [{"title": "序章", "brief": "介绍港口"}],
        }))
        item_id = batch["items"][0]["id"]
        await service.run_item(batch["id"], item_id)
        result = (await service.get_batch(batch["id"]))["items"][0]
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["result"]["approved"])
        roles = {trace["role"] for trace in result["result"]["agentTrace"]}
        self.assertEqual(roles, {"supervisor", "researcher", "writer", "editor", "critic"})
        self.assertTrue(any(msg["role"] == "critic" for msg in result["result"]["agentTrace"]))

    async def test_team_self_revises_on_critic_failure_then_passes(self):
        router = FakeRouter(fail_review_times=2)
        service = IPContentService(router, enable_agent_team=True, max_self_revisions=3)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "角色A不能离开港口",
            "chapters": [{"title": "序章", "brief": "介绍港口"}],
        }))
        await service.run_item(batch["id"], batch["items"][0]["id"])
        result = (await service.get_batch(batch["id"]))["items"][0]
        self.assertTrue(result["result"]["approved"])
        self.assertEqual([s for s, _, _ in router.calls].count("draft"), 3)
        actions = {trace["action"] for trace in result["result"]["agentTrace"]}
        self.assertIn("review_fail", actions)
        self.assertIn("draft_rewrite", actions)
        self.assertTrue(any(
            m["sender"] == "critic" and m["recipient"] == "writer" for m in result["result"]["agentMessages"]
        ))

    async def test_team_escalates_to_human_after_max_revisions(self):
        router = FakeRouter(fail_review_times=100)
        service = IPContentService(router, enable_agent_team=True, max_self_revisions=2)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "角色A不能离开港口",
            "chapters": [{"title": "序章", "brief": "介绍港口"}],
        }))
        await service.run_item(batch["id"], batch["items"][0]["id"])
        result = (await service.get_batch(batch["id"]))["items"][0]
        self.assertEqual(result["status"], "needs_review")
        self.assertFalse(result["result"]["approved"])
        actions = {trace["action"] for trace in result["result"]["agentTrace"]}
        self.assertIn("review_escalate", actions)
        # 达到上限后停止改写，避免死循环：初稿 + 两次改写。
        self.assertEqual([s for s, _, _ in router.calls].count("draft"), 3)

    async def test_team_mode_off_keeps_linear_pipeline(self):
        service = IPContentService(FakeRouter(), enable_agent_team=False)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "角色A不能离开港口",
            "chapters": [{"title": "序章", "brief": "介绍港口"}],
        }))
        await service.run_item(batch["id"], batch["items"][0]["id"])
        result = (await service.get_batch(batch["id"]))["items"][0]
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["result"]["agentTrace"], [])

    async def test_team_respects_existing_llm_router(self):
        # 真实 LLMRouter 在无密钥时应抛出清晰错误，证明团队层复用了同一代理。
        router = LLMRouter([])
        service = IPContentService(router, enable_agent_team=True)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "canon",
            "chapters": [{"title": "序章", "brief": "开场"}],
        }))
        # run_item 内部吞掉异常并把章节标为 failed；这里验证团队层复用了同一路由（无密钥报错）。
        await service.run_item(batch["id"], batch["items"][0]["id"])
        result = (await service.get_batch(batch["id"]))["items"][0]
        self.assertEqual(result["status"], "failed")


if __name__ == "__main__":
    unittest.main()
