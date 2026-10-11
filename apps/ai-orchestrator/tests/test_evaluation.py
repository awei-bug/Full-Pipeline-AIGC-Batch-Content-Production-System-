import asyncio
import unittest

from app.evaluation import EvalReport, PromptOptimizer, evaluate_chapter
from app.ip_content.service import MemoryStore


class EvaluationTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_content_fails_evaluation(self):
        report = evaluate_chapter("", threshold=0.7)
        self.assertFalse(report.passed)
        self.assertEqual(report.score, 0.0)
        self.assertTrue(any("成稿为空" in s for s in report.suggestions))

    async def test_short_content_with_broken_constraints_fails(self):
        lore = "角色不能离开港口。议会掌管航线许可。"
        report = evaluate_chapter(
            "这是一段很短的内容。", lore=lore,
            constraints=["角色不能离开港口"], threshold=0.7,
        )
        self.assertFalse(report.passed)
        self.assertLess(report.metrics["constraint_compliance"], 1.0)
        self.assertLess(report.metrics["lore_consistency"], 1.0)

    async def test_long_compliant_content_passes(self):
        lore = "角色不能离开港口。议会掌管航线许可。"
        # 700+ 字、含标点分句，且扎根两条设定事实与一条约束。
        body = "。".join([
            "小雨站在星港的灯塔上，回想起议会掌管航线许可的约定：角色不能离开港口"
        ] * 20)
        report = evaluate_chapter(body, lore=lore, constraints=["角色不能离开港口"], threshold=0.7)
        self.assertTrue(report.passed, report.metrics)
        self.assertGreaterEqual(report.metrics["constraint_compliance"], 0.9)
        # 二元组覆盖率对跨句边界略有余量，0.85 已能确认成稿扎根设定事实。
        self.assertGreaterEqual(report.metrics["lore_consistency"], 0.85)


class OptimizerTests(unittest.IsolatedAsyncioTestCase):
    async def test_optimizer_skips_when_disabled_or_passed_or_no_project(self):
        store = MemoryStore()
        router = _EngineerRouter()
        optimizer = PromptOptimizer(router, store, enabled=True)
        # 通过的不优化
        self.assertIsNone(await optimizer.maybe_optimize("p1", EvalReport(score=0.9, passed=True)))
        # 禁用不优化
        disabled = PromptOptimizer(router, store, enabled=False)
        self.assertIsNone(await disabled.maybe_optimize("p1", EvalReport(score=0.2, passed=False)))
        # 无 project_id 不优化
        self.assertIsNone(await optimizer.maybe_optimize(None, EvalReport(score=0.2, passed=False)))

    async def test_optimizer_persists_profile_and_loads_overrides(self):
        store = MemoryStore()
        router = _EngineerRouter()
        optimizer = PromptOptimizer(router, store, enabled=True)
        report = EvalReport(score=0.3, passed=False, suggestions=["设定扎根不足"])
        overrides = await optimizer.maybe_optimize("proj_x", report, lore="角色不能离开港口", title="序章")
        self.assertIsNotNone(overrides)
        self.assertEqual(set(overrides), {"researcher", "writer", "editor", "critic"})
        # 持久化后可被后续同库章节加载
        loaded = await optimizer.load_overrides("proj_x")
        self.assertEqual(loaded, overrides)
        self.assertIsNone(await optimizer.load_overrides("other"))


class _EngineerRouter:
    """桩路由：识别提示词优化工程师的系统提示词并返回四角色覆盖 JSON。"""

    OVERRIDES = {
        "researcher": "你是调研员（已优化）。",
        "writer": "你是编剧（已优化）。",
        "editor": "你是编辑（已优化）。",
        "critic": "你是审核员（已优化）。",
    }

    def __init__(self):
        self.calls = 0

    async def complete(self, messages, tools=None, **_kwargs):
        self.calls += 1
        system = messages[0]["content"]
        if "提示词优化工程师" in system:
            import json
            return {"message": {"content": json.dumps(self.OVERRIDES, ensure_ascii=False)},
                    "usage": {"total_tokens": 9}, "model": "test"}
        return {"message": {"content": "stub"}, "usage": {}, "model": "test"}


if __name__ == "__main__":
    unittest.main()
