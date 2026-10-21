from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from uuid import uuid4

from langgraph.checkpoint.memory import MemorySaver
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .graph import build_graph
from ..agents.team import build_team
from ..evaluation import evaluate_chapter, PromptOptimizer
from ..safety import run_safety
from ..cost import compute_cost, summarize_costs
from ..queue import MemoryJobQueue, RedisJobQueue

logger = logging.getLogger(__name__)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def chapter_context(previous: list[dict], *, limit: int = 9000) -> tuple[str, bool]:
    older, recent = previous[:-3], previous[-3:]
    recent_lines = []
    for chapter in recent:
        content = chapter["result"]["content"]
        excerpt = content if len(content) <= 1200 else f"{content[:700]} ... {content[-500:]}"
        recent_lines.append(f"{chapter['title']}（成稿）：{excerpt}")
    recent_text = "\n".join(recent_lines)
    available = max(0, limit - len(recent_text) - 1)
    older_lines = [
        f"{chapter['title'][:40]}（章节目标，非已确认事实）：{chapter['brief'][:60]}；"
        f"成稿结尾：{chapter['result']['content'][-90:]}"
        for chapter in older
    ]
    older_text = "\n".join(older_lines)
    incomplete = len(older_text) > available or len(recent_text) > limit
    if incomplete:
        older_text = older_text[-available:] if available else ""
    return "\n".join(part for part in (older_text, recent_text) if part), incomplete


class Chapter(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    brief: str = Field(min_length=1, max_length=5000)


class BatchRequest(BaseModel):
    ip_name: str = Field(min_length=1, max_length=120, alias="ipName")
    lore: str | None = Field(default=None, max_length=30000)
    project_id: str | None = Field(default=None, alias="projectId")
    strategy: Literal["auto", "A", "B"] = "auto"
    chapters: list[Chapter] = Field(min_length=1, max_length=50)

    @field_validator("ip_name")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("不能为空")
        return value.strip()

    @model_validator(mode="after")
    def require_canon(self):
        if not self.project_id and not (self.lore or "").strip():
            raise ValueError("需要选择设定库或提供世界观设定")
        return self


class ProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    lore: str = Field(min_length=1, max_length=30000)
    project_id: str | None = Field(default=None, alias="projectId")
    expected_version: int | None = Field(default=None, alias="expectedVersion", ge=1)

    @field_validator("name", "lore")
    @classmethod
    def strip_nonblank(cls, value):
        if not value.strip():
            raise ValueError("不能为空")
        return value.strip()


class HumanReview(BaseModel):
    decision: Literal["approved", "rejected"]
    note: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def require_rejection_reason(self):
        if self.decision == "rejected" and not self.note.strip():
            raise ValueError("退回修改时必须填写原因")
        return self


class VisualWorkflowRequest(BaseModel):
    outputs: list[Literal["image", "video"]] = Field(min_length=1, max_length=2)
    style: Literal["cinematic", "character", "environment"] = "cinematic"

    @field_validator("outputs")
    @classmethod
    def unique_outputs(cls, value):
        return list(dict.fromkeys(value))


class MemoryStore:
    def __init__(self):
        self.values: dict[str, dict] = {}
        self.queue: MemoryJobQueue = MemoryJobQueue()

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value):
        self.values[key] = value

    async def claim(self, key, token):
        if key in self.values:
            return False
        self.values[key] = token
        return True

    async def release(self, key, token):
        if self.values.get(key) == token:
            self.values.pop(key, None)

    async def locked(self, key):
        return key in self.values

    async def owns(self, key, token):
        return self.values.get(key) == token

    async def renew(self, key, token):
        return await self.owns(key, token)

    async def schedule(self, item_id, priority: float = 0.0):
        await self.queue.enqueue(item_id, priority=priority)

    async def unschedule(self, item_id):
        await self.queue.remove(item_id)

    async def candidates(self, limit: int = 500):
        return await self.queue.peek(limit)

    async def recover(self):
        return None

    async def project_ids(self):
        return [key.removeprefix("project:") for key in self.values if key.startswith("project:")]


class RedisStore:
    def __init__(self, client):
        self.client = client
        self.queue: RedisJobQueue = RedisJobQueue(client)

    async def get(self, key):
        raw = await self.client.get(f"ip:{key}")
        return json.loads(raw) if raw else None

    async def set(self, key, value):
        await self.client.set(f"ip:{key}", json.dumps(value, ensure_ascii=False), ex=7 * 24 * 3600)

    async def claim(self, key, token):
        return bool(await self.client.set(f"ip:{key}", token, nx=True, ex=120))

    async def release(self, key, token):
        await self.client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, f"ip:{key}", token)

    async def locked(self, key):
        return bool(await self.client.exists(f"ip:{key}"))

    async def owns(self, key, token):
        return await self.client.get(f"ip:{key}") == token

    async def renew(self, key, token):
        return bool(await self.client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], 120) else return 0 end",
            1, f"ip:{key}", token,
        ))

    async def schedule(self, item_id, priority: float = 0.0):
        await self.queue.enqueue(item_id, priority=priority)

    async def unschedule(self, item_id):
        await self.queue.remove(item_id)

    async def candidates(self, limit: int = 500):
        return await self.queue.peek(limit)

    async def index_project(self, project_id):
        await self.client.zadd("ip:projects", {project_id: time.time()})

    async def project_ids(self):
        return await self.client.zrevrange("ip:projects", 0, 99)

    async def recover(self):
        async for key in self.client.scan_iter(match="ip:batch:*"):
            batch = await self.get(key.removeprefix("ip:"))
            if not batch:
                continue
            for item_id in batch["itemIds"]:
                item = await self.get(f"item:{item_id}")
                if not item or item["status"] == "completed":
                    continue
                if item["status"] in ("queued", "running"):
                    await self.schedule(item_id)
                break


async def _keep_lease(store, item_id, token):
    while True:
        await asyncio.sleep(30)
        if not await store.renew(f"lock:{item_id}", token):
            return


class IPContentService:
    def __init__(self, router, *, store=None, checkpointer=None, search_key="",
                 enable_agent_team: bool = False, max_self_revisions: int = 3,
                 enable_planning: bool = False,
                 object_store=None, eval_enabled: bool = True, eval_threshold: float = 0.7,
                 prompt_opt_enabled: bool = False, safety_llm_enabled: bool = False,
                 safety_deny_words: list[str] | None = None, cost_pricing=None):
        self.router = router
        self.store = store or MemoryStore()
        self.checkpointer = checkpointer or MemorySaver()
        self.search_key = search_key
        self.enable_agent_team = enable_agent_team
        self.max_self_revisions = max_self_revisions
        self.enable_planning = enable_planning
        self.object_store = object_store
        self.eval_enabled = eval_enabled
        self.eval_threshold = eval_threshold
        self.prompt_opt_enabled = prompt_opt_enabled
        self.safety_llm_enabled = safety_llm_enabled
        self.safety_deny_words = list(safety_deny_words) if safety_deny_words else None
        self.cost_pricing = cost_pricing
        # 提示词自优化闭环：仅在开启且有 project_id 时触发，避免一次性任务无意义优化。
        self.optimizer = PromptOptimizer(router, self.store, enabled=prompt_opt_enabled)

    async def save_project(self, request: ProjectRequest) -> dict:
        project_id = request.project_id or uuid4().hex
        token = uuid4().hex
        if not await self.store.claim(f"project-edit:{project_id}", token):
            raise ValueError("设定库正在保存，请稍后重试")
        try:
            existing = await self.store.get(f"project:{project_id}")
            if request.project_id and not existing:
                raise ValueError("设定库不存在")
            if existing and request.expected_version != existing["version"]:
                raise ValueError("设定库版本已更新，请刷新后再保存")
            project = {"id": project_id, "name": request.name, "lore": request.lore,
                       "version": existing["version"] + 1 if existing else 1,
                       "createdAt": existing["createdAt"] if existing else now(), "updatedAt": now()}
            await self.store.set(f"project:{project_id}", project)
            if isinstance(self.store, RedisStore):
                await self.store.index_project(project_id)
            return project
        finally:
            await self.store.release(f"project-edit:{project_id}", token)

    async def get_project(self, project_id):
        return await self.store.get(f"project:{project_id}")

    async def list_projects(self):
        projects = [await self.get_project(id_) for id_ in await self.store.project_ids()]
        return [{key: project[key] for key in ("id", "name", "version", "updatedAt")}
                for project in projects if project]

    async def submit(self, request: BatchRequest) -> dict:
        project = await self.get_project(request.project_id) if request.project_id else None
        if request.project_id and not project:
            raise ValueError("设定库不存在")
        lore = project["lore"] if project else request.lore.strip()
        batch_id = uuid4().hex
        item_ids = []
        for index, chapter in enumerate(request.chapters):
            item_id = uuid4().hex
            item_ids.append(item_id)
            variant = request.strategy if request.strategy != "auto" else ("A" if (index + int(batch_id[:2], 16)) % 2 == 0 else "B")
            await self.store.set(f"item:{item_id}", {
                "id": item_id, "batchId": batch_id, "title": chapter.title,
                "brief": chapter.brief, "status": "queued", "stage": "queued",
                "createdAt": now(), "result": None, "error": None,
                "promptVariant": variant, "revisions": [], "humanReview": None,
                "visualWorkflow": None, "visualRevisions": [],
            })
        await self.store.set(f"batch:{batch_id}", {
            "id": batch_id, "ipName": request.ip_name, "lore": lore,
            "projectId": request.project_id, "projectVersion": project["version"] if project else None,
            "itemIds": item_ids, "createdAt": now(),
        })
        await self.store.schedule(item_ids[0])
        return await self.get_batch(batch_id)

    async def get_batch(self, batch_id: str) -> dict | None:
        batch = await self.store.get(f"batch:{batch_id}")
        if not batch:
            return None
        items = [await self.store.get(f"item:{item_id}") for item_id in batch["itemIds"]]
        statuses = {item["status"] for item in items if item}
        status = ("needs_review" if statuses & {"needs_review", "needs_revision"} else
                  "partial_failure" if "failed" in statuses and "completed" in statuses else
                  "failed" if "failed" in statuses else
                  "running" if statuses & {"queued", "running"} else "completed")
        variants = {variant: {"reviewed": 0, "approved": 0} for variant in ("A", "B")}
        for item in items:
            if item and item.get("humanReview"):
                row = variants[item["promptVariant"]]
                row["reviewed"] += 1
                row["approved"] += item["humanReview"]["decision"] == "approved"
        return {"id": batch_id, "ipName": batch["ipName"], "createdAt": batch["createdAt"],
                "projectId": batch.get("projectId"), "projectVersion": batch.get("projectVersion"),
                "status": status, "variants": variants, "costSummary": summarize_costs(items),
                "items": items}

    async def run_batch(self, batch_id: str):
        batch = await self.store.get(f"batch:{batch_id}")
        if batch:
            for item_id in batch["itemIds"]:
                item = await self.store.get(f"item:{item_id}")
                if item and item["status"] in ("queued", "running"):
                    await self.run_item(batch_id, item_id)
                    item = await self.store.get(f"item:{item_id}")
                if not item or item["status"] != "completed":
                    break

    async def worker_loop(self, stop: asyncio.Event, *, concurrency=12):
        if not hasattr(self.store, "candidates") or not hasattr(self.store, "schedule"):
            raise RuntimeError("持久 worker 需要支持队列的任务存储")
        await self.store.recover()
        running: set[asyncio.Task] = set()
        try:
            while not stop.is_set():
                try:
                    for item_id in await self.store.candidates():
                        if len(running) >= concurrency:
                            break
                        item = await self.store.get(f"item:{item_id}")
                        if not item or item["status"] in ("completed", "failed", "needs_review", "needs_revision"):
                            await self.store.unschedule(item_id)
                            continue
                        if await self.store.locked(f"lock:{item_id}"):
                            continue
                        task = asyncio.create_task(self.run_item(item["batchId"], item_id))
                        running.add(task)
                        task.add_done_callback(running.discard)
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=1)
                    except asyncio.TimeoutError:
                        pass
                except Exception:
                    logger.exception("IP task worker failed to poll Redis; retrying")
                    await asyncio.sleep(2)
        finally:
            if running:
                await asyncio.gather(*running, return_exceptions=True)

    async def run_item(self, batch_id: str, item_id: str):
        batch = await self.store.get(f"batch:{batch_id}")
        item = await self.store.get(f"item:{item_id}")
        if not batch or not item or item_id not in batch["itemIds"] or item["status"] not in ("queued", "running"):
            return
        index = batch["itemIds"].index(item_id)
        previous = [await self.store.get(f"item:{id_}") for id_ in batch["itemIds"][:index]]
        if any(not chapter or chapter["status"] != "completed" for chapter in previous):
            return
        token = uuid4().hex
        if not await self.store.claim(f"lock:{item_id}", token):
            return
        lease = asyncio.create_task(_keep_lease(self.store, item_id, token)) if isinstance(self.store, RedisStore) else None
        try:
            item["status"] = "running"
            item["error"] = None
            await self.store.set(f"item:{item_id}", item)

            async def assert_lease():
                if not await self.store.owns(f"lock:{item_id}", token):
                    raise RuntimeError("任务执行锁已失效，将由队列重新领取")

            async def on_stage(stage):
                await assert_lease()
                current = await self.store.get(f"item:{item_id}")
                current["stage"] = stage
                await self.store.set(f"item:{item_id}", current)

            prompt_overrides = None
            if self.enable_agent_team and batch.get("projectId"):
                prompt_overrides = await self.optimizer.load_overrides(batch["projectId"])
            if self.enable_agent_team:
                graph = build_team(self.router, checkpointer=self.checkpointer,
                                   on_stage=on_stage, assert_lease=assert_lease,
                                   search_key=self.search_key, max_revisions=self.max_self_revisions,
                                   prompt_overrides=prompt_overrides,
                                   enable_planning=self.enable_planning)
            else:
                graph = build_graph(self.router, checkpointer=self.checkpointer,
                                    on_stage=on_stage, assert_lease=assert_lease,
                                    search_key=self.search_key)
            config = {"configurable": {"thread_id": item_id}}
            snapshot = await graph.aget_state(config)
            context, incomplete = chapter_context(previous)
            base_initial = {
                "title": item["title"], "brief": item["brief"], "lore": batch["lore"],
                "prompt_variant": item["promptVariant"],
                "previous_chapters": context, "continuity_incomplete": incomplete, "usage": {},
            }
            if self.enable_agent_team:
                base_initial.update({
                    "revision": 0, "next": "supervisor", "needs_human_review": False,
                    "agent_trace": [], "memory_constraints": [], "memory_issues": [],
                    "agent_messages": [],
                })
            initial = None if snapshot.values else base_initial
            state = await graph.ainvoke(initial, config=config)
            if not await self.store.owns(f"lock:{item_id}", token):
                return
            item = await self.store.get(f"item:{item_id}")
            current_previous = [await self.store.get(f"item:{id_}") for id_ in batch["itemIds"][:index]]
            stale = any(not chapter or chapter["status"] != "completed" or chapter.get("staleContext") for chapter in current_previous)
            continuity_incomplete = state.get("continuity_incomplete", False)
            approved = bool(state.get("approved"))
            final_content = state.get("polished") or state.get("content") or ""

            # —— 评测 / 安全 / 成本 / 持久化：均为增强层，异常不中断主链路 ——
            eval_report = None
            safety_report = None
            cost = None
            object_key = None
            object_uri = None
            try:
                if self.eval_enabled:
                    eval_report = evaluate_chapter(
                        final_content, lore=batch["lore"],
                        constraints=state.get("memory_constraints"), threshold=self.eval_threshold,
                    )
                    if self.prompt_opt_enabled and batch.get("projectId") and not eval_report.passed:
                        await self.optimizer.maybe_optimize(
                            batch["projectId"], eval_report, lore=batch["lore"], title=item["title"],
                        )
                safety_report = await run_safety(
                    final_content, title=item["title"], lore=batch["lore"],
                    router=self.router if self.safety_llm_enabled else None,
                    llm_enabled=self.safety_llm_enabled, deny_words=self.safety_deny_words,
                )
                cost = compute_cost(state.get("usage"), state.get("model"), self.cost_pricing)
                if self.object_store and final_content:
                    ref = await self.object_store.put(
                        f"ip-content/{batch_id}/{item_id}.json",
                        json.dumps({
                            "title": item["title"], "content": final_content,
                            "research": state.get("research"), "review": state.get("review"),
                            "usage": state.get("usage"), "model": state.get("model"),
                            "evalReport": eval_report.to_dict() if eval_report else None,
                            "safety": safety_report.to_dict() if safety_report else None,
                            "cost": cost.to_dict() if cost else None,
                        }, ensure_ascii=False),
                    )
                    object_key, object_uri = ref.key, ref.uri
            except Exception as exc:  # 增强层失败不应让章节失败。
                logger.warning("章节增强层（评测/安全/成本/存储）异常，已跳过：%s", exc)

            safety_hold = bool(safety_report and safety_report.hold)
            needs_human = bool(state.get("needs_human_review", False)) or safety_hold or \
                (not approved and not stale and not continuity_incomplete)
            item.update(status="completed" if (approved and not stale and not continuity_incomplete and not safety_hold) else "needs_review", stage="complete", result={
                "research": state["research"], "draft": state["draft"],
                "content": final_content, "review": state["review"],
                "approved": approved, "usage": state.get("usage", {}),
                "model": state.get("model"),
                "agentTrace": state.get("agent_trace", []),
                "agentMessages": state.get("agent_messages", []),
                "needsHumanReview": needs_human,
                "evalReport": eval_report.to_dict() if eval_report else None,
                "safety": safety_report.to_dict() if safety_report else None,
                "cost": cost.to_dict() if cost else None,
                "objectKey": object_key,
                "objectUri": object_uri,
                "safetyHold": safety_hold,
            }, error=None, humanReview=None, staleContext=stale,
                continuityIncomplete=continuity_incomplete)
            if item.get("visualWorkflow"):
                item["visualRevisions"] = [*item.get("visualRevisions", []), item["visualWorkflow"]]
                item["visualWorkflow"] = None
            await self.store.set(f"item:{item_id}", item)
            await self.store.unschedule(item_id)
            if item["status"] == "completed" and index + 1 < len(batch["itemIds"]):
                await self.store.schedule(batch["itemIds"][index + 1])
        except Exception as exc:
            item = await self.store.get(f"item:{item_id}")
            if item and await self.store.owns(f"lock:{item_id}", token):
                item.update(status="failed", error=str(exc)[:500])
                await self.store.set(f"item:{item_id}", item)
                await self.store.unschedule(item_id)
        finally:
            if lease:
                lease.cancel()
                await asyncio.gather(lease, return_exceptions=True)
            await self.store.release(f"lock:{item_id}", token)

    async def retry(self, batch_id: str, item_id: str) -> dict | None:
        batch = await self.store.get(f"batch:{batch_id}")
        if not batch or item_id not in batch["itemIds"]:
            return None
        item = await self.store.get(f"item:{item_id}")
        if item["status"] not in ("failed", "running"):
            raise ValueError("只能恢复失败或中断的任务")
        if await self.store.locked(f"lock:{item_id}"):
            raise ValueError("章节仍在执行，请等待当前任务结束后再恢复")
        item.update(status="queued", error=None)
        await self.store.set(f"item:{item_id}", item)
        await self.store.schedule(item_id)
        return item

    async def review(self, batch_id: str, item_id: str, request: HumanReview) -> dict | None:
        batch = await self.store.get(f"batch:{batch_id}")
        if not batch or item_id not in batch["itemIds"]:
            return None
        item = await self.store.get(f"item:{item_id}")
        if not item.get("result") or item["status"] not in ("completed", "needs_review", "needs_revision"):
            raise ValueError("章节尚无可审核成稿")
        if await self.store.locked(f"lock:{item_id}"):
            raise ValueError("章节仍在生成，请稍后审核")
        if request.decision == "approved" and item.get("staleContext"):
            raise ValueError("前章内容已变更，请退回重写本章后再审核")
        item["humanReview"] = {"decision": request.decision, "note": request.note.strip(), "reviewedAt": now()}
        item["status"] = "completed" if request.decision == "approved" else "needs_revision"
        await self.store.set(f"item:{item_id}", item)
        index = batch["itemIds"].index(item_id)
        if request.decision == "approved" and index + 1 < len(batch["itemIds"]):
            next_item = await self.store.get(f"item:{batch['itemIds'][index + 1]}")
            if next_item and next_item["status"] == "queued":
                await self.store.schedule(next_item["id"])
        if request.decision == "rejected":
            if item.get("visualWorkflow"):
                item["visualWorkflow"]["stale"] = True
                await self.store.set(f"item:{item_id}", item)
            for later_id in batch["itemIds"][index + 1:]:
                later = await self.store.get(f"item:{later_id}")
                if later and later.get("result"):
                    later["staleContext"] = True
                    await self.store.set(f"item:{later_id}", later)
                if later and later["status"] == "queued":
                    await self.store.unschedule(later_id)
        return item

    async def revise(self, batch_id: str, item_id: str) -> dict | None:
        batch = await self.store.get(f"batch:{batch_id}")
        if not batch or item_id not in batch["itemIds"]:
            return None
        item = await self.store.get(f"item:{item_id}")
        if item["status"] != "needs_revision" or not item.get("humanReview", {}).get("note"):
            raise ValueError("请先填写退回原因")
        if await self.store.locked(f"lock:{item_id}"):
            raise ValueError("章节正在执行")
        if self.enable_agent_team:
            graph = build_team(self.router, checkpointer=self.checkpointer, search_key=self.search_key,
                               max_revisions=self.max_self_revisions)
            config = {"configurable": {"thread_id": item_id}}
            # 把人工退回意见注入为反馈，并清空下游产物，让 supervisor 重放 撰写→润色→审核。
            await graph.aupdate_state(config, {
                "feedback": item["humanReview"]["note"],
                "next": "writer", "polished": None, "review": None, "approved": False,
            }, as_node="supervisor")
        else:
            graph = build_graph(self.router, checkpointer=self.checkpointer, search_key=self.search_key)
            config = {"configurable": {"thread_id": item_id}}
            await graph.aupdate_state(config, {"feedback": item["humanReview"]["note"]}, as_node="agent_research")
        item["revisions"] = [*item.get("revisions", []), item["result"]]
        item.update(status="queued", stage="queued", error=None, result=None)
        await self.store.set(f"item:{item_id}", item)
        await self.store.schedule(item_id)
        return item

    async def visual_source(self, batch_id: str, item_id: str) -> tuple[dict, dict] | None:
        batch = await self.store.get(f"batch:{batch_id}")
        if not batch or item_id not in batch["itemIds"]:
            return None
        item = await self.store.get(f"item:{item_id}")
        if not item or not item.get("result"):
            raise ValueError("章节尚无可用成稿")
        if (item.get("humanReview") or {}).get("decision") != "approved":
            raise ValueError("章节需人工验收通过后才能生成视觉素材")
        if item.get("staleContext") or item.get("continuityIncomplete"):
            raise ValueError("章节上下文仍需复核，不能生成视觉素材")
        return batch, item

    async def attach_visual_workflow(
        self,
        batch_id: str,
        item_id: str,
        workflow: dict,
        request: VisualWorkflowRequest,
    ) -> dict | None:
        source = await self.visual_source(batch_id, item_id)
        if source is None:
            return None
        _, item = source
        previous = item.get("visualWorkflow")
        if previous:
            item["visualRevisions"] = [*item.get("visualRevisions", []), previous]
        item["visualWorkflow"] = {
            "id": workflow["id"],
            "status": workflow.get("status", "queued"),
            "outputs": request.outputs,
            "style": request.style,
            "createdAt": workflow.get("createdAt") or now(),
            "stale": False,
        }
        await self.store.set(f"item:{item_id}", item)
        return item
