import asyncio
import json
import unittest

import httpx
from pydantic import ValidationError

from app.ip_content.router import LLMRouter
from app.ip_content.lore import search_lore
from app.ip_content.service import (
    BatchRequest,
    HumanReview,
    IPContentService,
    MemoryStore,
    ProjectRequest,
    RedisStore,
    VisualWorkflowRequest,
    chapter_context,
)


class StubRouter:
    def __init__(self):
        self.calls = []
        self.fail_polish = False

    async def complete(self, messages, tools=None, **_kwargs):
        system = messages[0]["content"]
        stage = next(key for key, token in {
            "research": "调研员", "draft": "编剧", "polish": "叙事编辑", "review": "审核员",
        }.items() if token in system)
        self.calls.append((stage, messages[1]["content"], bool(tools)))
        if stage == "polish" and self.fail_polish:
            raise RuntimeError("temporary failure")
        return {"message": {"content": "PASS\n依据：设定一致" if stage == "review" else f"{stage} 内容"},
                "usage": {"total_tokens": 5}, "model": "test-model"}


class IPTests(unittest.IsolatedAsyncioTestCase):
    async def test_queued_item_resumes_after_worker_restarts(self):
        class QueueStore(RedisStore):
            def __init__(self):
                self.memory = MemoryStore()
                self.queue = set()

            async def get(self, key): return await self.memory.get(key)
            async def set(self, key, value): await self.memory.set(key, value)
            async def claim(self, key, token): return await self.memory.claim(key, token)
            async def release(self, key, token): await self.memory.release(key, token)
            async def locked(self, key): return await self.memory.locked(key)
            async def owns(self, key, token): return await self.memory.owns(key, token)
            async def renew(self, key, token): return await self.memory.renew(key, token)
            async def schedule(self, item_id): self.queue.add(item_id)
            async def unschedule(self, item_id): self.queue.discard(item_id)
            async def candidates(self): return list(self.queue)
            async def recover(self): return None

        router = StubRouter()
        router.fail_polish = True
        store = QueueStore()
        service = IPContentService(router, store=store)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "角色A不能离开港口",
            "chapters": [{"title": "序章", "brief": "开场"}],
        }))
        item_id = batch["items"][0]["id"]
        await service.run_item(batch["id"], item_id)
        self.assertEqual((await store.get(f"item:{item_id}"))["status"], "failed")
        router.fail_polish = False
        interrupted = await store.get(f"item:{item_id}")
        interrupted["status"] = "running"
        await store.set(f"item:{item_id}", interrupted)
        await store.schedule(item_id)
        restarted = IPContentService(router, store=store, checkpointer=service.checkpointer)
        stop = asyncio.Event()
        worker = asyncio.create_task(restarted.worker_loop(stop, concurrency=2))
        try:
            for _ in range(50):
                if (await restarted.get_batch(batch["id"]))["status"] == "completed":
                    break
                await asyncio.sleep(0.05)
            self.assertEqual((await restarted.get_batch(batch["id"]))["status"], "completed")
            self.assertEqual([stage for stage, _, _ in router.calls].count("research"), 1)
            self.assertFalse(store.queue)
        finally:
            stop.set()
            await worker

    async def test_project_versions_are_snapshotted_into_batches(self):
        service = IPContentService(StubRouter())
        first = await service.save_project(ProjectRequest.model_validate({
            "name": "星港", "lore": "角色A不能离开港口",
        }))
        self.assertEqual(len(await service.list_projects()), 1)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "projectId": first["id"],
            "chapters": [{"title": "序章", "brief": "介绍港口"}],
        }))
        updated = await service.save_project(ProjectRequest.model_validate({
            "projectId": first["id"], "expectedVersion": 1,
            "name": "星港", "lore": "角色A现在能离开港口",
        }))
        self.assertEqual(updated["version"], 2)
        self.assertEqual((await service.store.get(f"batch:{batch['id']}"))["lore"], first["lore"])
        self.assertEqual(batch["projectVersion"], 1)
        with self.assertRaisesRegex(ValueError, "版本已更新"):
            await service.save_project(ProjectRequest.model_validate({
                "projectId": first["id"], "expectedVersion": 1,
                "name": "星港", "lore": "新设定",
            }))

    async def test_chapter_two_uses_chapter_one_and_prompt_variants_alternate(self):
        router = StubRouter()
        service = IPContentService(router)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "角色A不能离开港口",
            "chapters": [{"title": "序章", "brief": "介绍港口"}, {"title": "下一章", "brief": "延续故事"}],
        }))
        await service.run_batch(batch["id"])
        result = await service.get_batch(batch["id"])
        self.assertNotEqual(result["items"][0]["promptVariant"], result["items"][1]["promptVariant"])
        self.assertIn("序章（成稿）：polish 内容", next(text for stage, text, _ in router.calls if stage == "draft" and "下一章" in text))

    async def test_chapter_five_retains_early_story_constraints(self):
        router = StubRouter()
        service = IPContentService(router)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "航行必须获得议会许可",
            "chapters": [
                {"title": "序章", "brief": "小雨与议会立约，不得擅自离港"},
                {"title": "第二章", "brief": "调查港口"},
                {"title": "第三章", "brief": "发现航线"},
                {"title": "第四章", "brief": "准备航行"},
                {"title": "第五章", "brief": "回顾小雨的约定"},
            ],
        }))
        await service.run_batch(batch["id"])
        fifth = next(text for stage, text, _ in router.calls if stage == "review" and "第五章" in text)
        self.assertIn("不得擅自离港", fifth)
        self.assertEqual((await service.get_batch(batch["id"]))["status"], "completed")

    async def test_unparseable_review_never_auto_approves(self):
        class AmbiguousReview(StubRouter):
            async def complete(self, messages, tools=None, **kwargs):
                if "审核员" in messages[0]["content"]:
                    return {"message": {"content": "PASSAGE 看起来一致"}, "usage": {}, "model": "test"}
                return await super().complete(messages, tools, **kwargs)

        service = IPContentService(AmbiguousReview())
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "角色不得离港",
            "chapters": [{"title": "序章", "brief": "介绍港口"}, {"title": "下一章", "brief": "继续"}],
        }))
        await service.run_batch(batch["id"])
        result = await service.get_batch(batch["id"])
        self.assertEqual(result["items"][0]["status"], "needs_review")
        self.assertIn("需人工复核", result["items"][0]["result"]["review"])
        self.assertEqual(result["items"][1]["status"], "queued")

    async def test_oversized_story_context_requires_manual_review(self):
        previous = [{"title": f"第{i}章", "brief": "长期人物关系" * 100,
                     "result": {"content": "复杂剧情" * 400}} for i in range(49)]
        context, incomplete = chapter_context(previous)
        self.assertTrue(incomplete)
        self.assertLessEqual(len(context), 9000)
        self.assertIn("第48章", context)

        router = StubRouter()
        service = IPContentService(router)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "世界观规则", "chapters": [
                {"title": f"第{i}章", "brief": "长期人物关系" * 100} for i in range(50)
            ],
        }))
        for previous_item in batch["items"][:-1]:
            previous_item.update(status="completed", result={"content": "复杂剧情" * 400})
            await service.store.set(f"item:{previous_item['id']}", previous_item)
        last_id = batch["items"][-1]["id"]
        await service.run_item(batch["id"], last_id)
        last = (await service.get_batch(batch["id"]))["items"][-1]
        self.assertEqual(last["status"], "needs_review")
        self.assertTrue(last["continuityIncomplete"])

    async def test_model_rejection_pauses_until_manual_review_and_revision(self):
        class RejectOnce(StubRouter):
            def __init__(self):
                super().__init__()
                self.reject = True

            async def complete(self, messages, tools=None, **kwargs):
                if self.reject and "审核员" in messages[0]["content"]:
                    self.reject = False
                    self.calls.append(("review", messages[1]["content"], False))
                    return {"message": {"content": "FAIL\n依据：人物行动与设定冲突"},
                            "usage": {"total_tokens": 5}, "model": "test-model"}
                return await super().complete(messages, tools, **kwargs)

        router = RejectOnce()
        service = IPContentService(router)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "角色A不能离开港口",
            "chapters": [{"title": "序章", "brief": "介绍港口"}, {"title": "下一章", "brief": "延续故事"}],
        }))
        first, second = (item["id"] for item in batch["items"])
        await service.run_batch(batch["id"])
        paused = await service.get_batch(batch["id"])
        self.assertEqual(paused["status"], "needs_review")
        self.assertEqual(paused["items"][1]["status"], "queued")
        await service.review(batch["id"], first, HumanReview(decision="rejected", note="保持角色在港口"))
        with self.assertRaisesRegex(ValueError, "先填写退回原因"):
            await service.revise(batch["id"], second)
        await service.revise(batch["id"], first)
        await service.run_batch(batch["id"])
        result = await service.get_batch(batch["id"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(result["items"][0]["revisions"]), 1)
        self.assertEqual([stage for stage, _, _ in router.calls].count("research"), 2)
        self.assertIn("保持角色在港口", next(text for stage, text, _ in router.calls if stage == "draft" and "人工修改要求：保持" in text))

    async def test_manual_approval_unblocks_next_chapter_and_tracks_variants(self):
        class RejectAll(StubRouter):
            async def complete(self, messages, tools=None, **kwargs):
                if "审核员" in messages[0]["content"]:
                    return {"message": {"content": "FAIL\n依据：待人工判断"}, "usage": {}, "model": "test"}
                return await super().complete(messages, tools, **kwargs)

        service = IPContentService(RejectAll())
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "canon", "strategy": "B",
            "chapters": [{"title": "序章", "brief": "开场"}, {"title": "终章", "brief": "结局"}],
        }))
        await service.run_batch(batch["id"])
        await service.review(batch["id"], batch["items"][0]["id"], HumanReview(decision="approved"))
        await service.run_batch(batch["id"])
        result = await service.get_batch(batch["id"])
        self.assertEqual(result["items"][1]["status"], "needs_review")
        self.assertEqual(result["variants"]["B"], {"reviewed": 1, "approved": 1})

    async def test_visual_workflow_requires_human_approval_and_is_attached_to_chapter(self):
        service = IPContentService(StubRouter())
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "小雨不能离开港口",
            "chapters": [{"title": "序章", "brief": "小雨守望星港"}],
        }))
        item_id = batch["items"][0]["id"]
        await service.run_batch(batch["id"])
        with self.assertRaisesRegex(ValueError, "人工验收通过"):
            await service.visual_source(batch["id"], item_id)

        await service.review(batch["id"], item_id, HumanReview(decision="approved"))
        source = await service.visual_source(batch["id"], item_id)
        self.assertEqual(source[1]["title"], "序章")
        request = VisualWorkflowRequest(outputs=["image", "video"], style="cinematic")
        attached = await service.attach_visual_workflow(
            batch["id"], item_id,
            {"id": "cw_visual", "status": "queued", "createdAt": "2026-09-24T00:00:00Z"},
            request,
        )
        self.assertEqual(attached["visualWorkflow"]["id"], "cw_visual")
        self.assertEqual(attached["visualWorkflow"]["outputs"], ["image", "video"])

    async def test_rejecting_earlier_chapter_marks_later_drafts_stale(self):
        service = IPContentService(StubRouter())
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "港口事实",
            "chapters": [{"title": "序章", "brief": "开场"}, {"title": "终章", "brief": "结局"}],
        }))
        await service.run_batch(batch["id"])
        first, second = (item["id"] for item in batch["items"])
        await service.review(batch["id"], first, HumanReview(decision="rejected", note="前章人物关系不符"))
        stale = (await service.get_batch(batch["id"]))["items"][1]
        self.assertTrue(stale["staleContext"])
        with self.assertRaisesRegex(ValueError, "前章内容已变更"):
            await service.review(batch["id"], second, HumanReview(decision="approved"))

    async def test_lore_search_ranks_relevant_chinese_character_facts(self):
        lore = "\n\n".join(["宇宙飞船的燃料是晶体" * 20,
                              "角色小雨不能离开星港" * 20, "沙漠城有地下河" * 20])
        self.assertIn("角色小雨不能离开星港", search_lore(lore, "小雨离开星港", limit=1))

    async def test_batch_completes_with_separate_stage_context_and_usage(self):
        router = StubRouter()
        service = IPContentService(router)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "角色A不能离开港口", "chapters": [
                {"title": "序章", "brief": "交代港口"},
                {"title": "终章", "brief": "解决冲突"},
            ],
        }))
        await service.run_batch(batch["id"])
        result = await service.get_batch(batch["id"])
        self.assertEqual(result["status"], "completed", result["items"])
        self.assertEqual(len(router.calls), 8)
        self.assertEqual(sum(bool(tools) for _, _, tools in router.calls), 2)
        self.assertTrue(all(item["result"]["approved"] for item in result["items"]))
        self.assertEqual(result["items"][0]["result"]["usage"]["total_tokens"], 20)
        self.assertNotIn("research 内容", next(text for stage, text, _ in router.calls if stage == "polish"))

    async def test_failure_retries_only_unfinished_nodes(self):
        router = StubRouter()
        router.fail_polish = True
        service = IPContentService(router)
        batch = await service.submit(BatchRequest.model_validate({
            "ipName": "星港", "lore": "角色A不能离开港口",
            "chapters": [{"title": "序章", "brief": "交代港口"}],
        }))
        item_id = batch["items"][0]["id"]
        await service.run_item(batch["id"], item_id)
        self.assertEqual((await service.get_batch(batch["id"]))["items"][0]["status"], "failed")
        router.fail_polish = False
        await service.retry(batch["id"], item_id)
        await service.run_item(batch["id"], item_id)
        self.assertEqual([stage for stage, _, _ in router.calls].count("research"), 1, await service.get_batch(batch["id"]))
        self.assertEqual([stage for stage, _, _ in router.calls].count("draft"), 1)
        self.assertEqual((await service.get_batch(batch["id"]))["items"][0]["status"], "completed")

    async def test_validation_rejects_empty_lore_and_too_many_chapters(self):
        with self.assertRaises(ValidationError):
            BatchRequest.model_validate({"ipName": "星港", "lore": " ", "chapters": [{"title": "1", "brief": "test"}]})
        with self.assertRaises(ValidationError):
            BatchRequest.model_validate({"ipName": "星港", "lore": "canon", "chapters": [{"title": str(i), "brief": "test"} for i in range(51)]})

    async def test_tool_lookup_keeps_each_chapters_lore_isolated(self):
        class ToolRouter(StubRouter):
            async def complete(self, messages, tools=None, **kwargs):
                if tools and messages[0]["content"].find("调研员") >= 0:
                    return {"message": {"content": None, "tool_calls": [{
                        "id": "call-1", "type": "function", "function": {
                            "name": "query_ip_lore", "arguments": json.dumps({"query": "setting"}),
                        },
                    }]}, "usage": {}, "model": "test-model"}
                if messages[-1]["role"] == "tool":
                    self.calls.append(("lookup", messages[-1]["content"], False))
                    return {"message": {"content": "research 内容"}, "usage": {}, "model": "test-model"}
                return await super().complete(messages, tools, **kwargs)

        router = ToolRouter()
        service = IPContentService(router)
        batches = [await service.submit(BatchRequest.model_validate({
            "ipName": "test", "lore": f"setting for {name}",
            "chapters": [{"title": name, "brief": "draft"}],
        })) for name in ("east", "west")]
        await asyncio.gather(*(service.run_batch(batch["id"]) for batch in batches))
        self.assertEqual({text.split("] ", 1)[-1] for stage, text, _ in router.calls if stage == "lookup"},
                         {"setting for east", "setting for west"})

    async def test_router_fails_over_transient_errors_and_reuses_connections(self):
        transports = []
        def client_factory(**_kwargs):
            index = len(transports)
            async def respond(request):
                if index == 0:
                    return httpx.Response(503, json={"error": "busy"})
                return httpx.Response(200, json={"choices": [{"message": {"content": "done"}}], "usage": {"total_tokens": 2}})
            transport = httpx.MockTransport(respond)
            transports.append(transport)
            return httpx.AsyncClient(transport=transport, base_url="https://example.test")
        router = LLMRouter([{"name": str(i), "api_key": "test", "base_url": "https://example.test", "model": "test"} for i in range(2)], client_factory=client_factory)
        try:
            response = await router.complete([{"role": "user", "content": "go"}])
            self.assertEqual(response["message"]["content"], "done")
            self.assertEqual(router.failures, [1, 0])
        finally:
            await router.close()


if __name__ == "__main__":
    unittest.main()
