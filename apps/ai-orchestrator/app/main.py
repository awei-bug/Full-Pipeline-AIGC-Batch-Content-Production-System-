from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException

from .config import Settings
from .models import WorkflowRequest
from .services.orchestration_service import OrchestrationService
from .ip_content.router import LLMRouter
from .ip_content.service import (
    BatchRequest,
    HumanReview,
    IPContentService,
    ProjectRequest,
    RedisStore,
    VisualWorkflowRequest,
)
from .storage import build_object_store


settings = Settings.from_env()
service = OrchestrationService(settings)


@asynccontextmanager
async def lifespan(app: FastAPI):
    choices = {
        "agnes": {"name": "agnes", "api_key": settings.agnes_api_key,
                  "base_url": settings.agnes_base_url, "model": settings.agnes_text_model,
                  "trust_env": settings.agnes_trust_env},
        "modelscope": {"name": "modelscope", "api_key": settings.modelscope_api_token,
                       "base_url": settings.modelscope_base_url, "model": settings.modelscope_text_model},
    }
    providers = [choices[name] for name in (settings.text_provider, "modelscope" if settings.text_provider == "agnes" else "agnes") if name in choices]
    router = LLMRouter(providers, requests_per_minute=int(os.getenv("IP_LLM_RPM", "60")))
    enable_agent_team = os.getenv("AGENT_TEAM_MODE", "1") != "0"
    max_self_revisions = int(os.getenv("AGENT_MAX_REVISIONS", "3"))
    redis_url = os.getenv("IP_REDIS_URL", "").strip()
    try:
        object_store = build_object_store(
            settings.object_store_backend,
            local_dir=settings.object_store_local_dir,
            bucket=settings.object_store_bucket,
            prefix=settings.object_store_prefix,
            endpoint_url=settings.object_store_endpoint,
        )
        if redis_url:
            from redis.asyncio import Redis
            from langgraph.checkpoint.redis.aio import AsyncRedisSaver

            client = Redis.from_url(redis_url, decode_responses=True)
            try:
                await client.ping()
                router.rate_redis = client
                async with AsyncRedisSaver.from_conn_string(redis_url, ttl={"default_ttl": 7 * 24 * 60}) as saver:
                    await saver.asetup()
                    app.state.ip_service = IPContentService(
                        router, store=RedisStore(client), checkpointer=saver,
                        search_key=os.getenv("BRAVE_SEARCH_API_KEY", ""),
                        enable_agent_team=enable_agent_team, max_self_revisions=max_self_revisions,
                        object_store=object_store, eval_enabled=settings.eval_enabled,
                        eval_threshold=settings.eval_threshold, prompt_opt_enabled=settings.prompt_opt_enabled,
                        safety_llm_enabled=settings.safety_llm_enabled, safety_deny_words=settings.safety_deny_words,
                        cost_pricing=settings.cost_pricing,
                    )
                    stop_worker = asyncio.Event()
                    worker = asyncio.create_task(app.state.ip_service.worker_loop(stop_worker))
                    try:
                        yield
                    finally:
                        stop_worker.set()
                        await worker
            finally:
                await client.aclose()
        else:
            app.state.ip_service = IPContentService(
                router, search_key=os.getenv("BRAVE_SEARCH_API_KEY", ""),
                enable_agent_team=enable_agent_team, max_self_revisions=max_self_revisions,
                object_store=object_store, eval_enabled=settings.eval_enabled,
                eval_threshold=settings.eval_threshold, prompt_opt_enabled=settings.prompt_opt_enabled,
                safety_llm_enabled=settings.safety_llm_enabled, safety_deny_words=settings.safety_deny_words,
                cost_pricing=settings.cost_pricing,
            )
            yield
    finally:
        await router.close()


app = FastAPI(title="智能编排服务", version="0.4.0", lifespan=lifespan)

IP_VISUAL_STYLES = {
    "cinematic": {
        "id": "cinematic",
        "label": "电影叙事",
        "prompt": "cinematic narrative keyframe, grounded production design, dramatic motivated lighting",
    },
    "character": {
        "id": "character",
        "label": "角色聚焦",
        "prompt": "character-driven visual development, expressive acting, consistent costume and facial identity",
    },
    "environment": {
        "id": "environment",
        "label": "世界场景",
        "prompt": "environment concept art, strong sense of place, coherent architecture and world-building details",
    },
}


@app.get("/internal/ip-content/projects")
async def list_ip_projects() -> dict:
    return {"code": "SUCCESS", "data": await app.state.ip_service.list_projects()}


@app.post("/internal/ip-content/projects")
async def save_ip_project(payload: ProjectRequest) -> dict:
    try:
        project = await app.state.ip_service.save_project(payload)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"code": "SUCCESS", "data": project}


@app.get("/internal/ip-content/projects/{project_id}")
async def get_ip_project(project_id: str) -> dict:
    project = await app.state.ip_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="设定库不存在")
    return {"code": "SUCCESS", "data": project}


@app.post("/internal/ip-content/batches", status_code=202)
async def create_ip_batch(payload: BatchRequest, background_tasks: BackgroundTasks) -> dict:
    try:
        batch = await app.state.ip_service.submit(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if not isinstance(app.state.ip_service.store, RedisStore):
        background_tasks.add_task(app.state.ip_service.run_batch, batch["id"])
    return {"code": "SUCCESS", "data": batch}


@app.get("/internal/ip-content/batches/{batch_id}")
async def get_ip_batch(batch_id: str) -> dict:
    batch = await app.state.ip_service.get_batch(batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="批次不存在或已过期")
    return {"code": "SUCCESS", "data": batch}


@app.post("/internal/ip-content/batches/{batch_id}/items/{item_id}/retry", status_code=202)
async def retry_ip_item(batch_id: str, item_id: str, background_tasks: BackgroundTasks) -> dict:
    try:
        item = await app.state.ip_service.retry(batch_id, item_id)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if not item:
        raise HTTPException(status_code=404, detail="章节不存在")
    if not isinstance(app.state.ip_service.store, RedisStore):
        background_tasks.add_task(app.state.ip_service.run_batch, batch_id)
    return {"code": "SUCCESS", "data": item}


@app.post("/internal/ip-content/batches/{batch_id}/items/{item_id}/review")
async def review_ip_item(batch_id: str, item_id: str, payload: HumanReview,
                         background_tasks: BackgroundTasks) -> dict:
    try:
        item = await app.state.ip_service.review(batch_id, item_id, payload)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if not item:
        raise HTTPException(status_code=404, detail="章节不存在")
    if payload.decision == "approved" and not isinstance(app.state.ip_service.store, RedisStore):
        background_tasks.add_task(app.state.ip_service.run_batch, batch_id)
    return {"code": "SUCCESS", "data": item}


@app.post("/internal/ip-content/batches/{batch_id}/items/{item_id}/revise", status_code=202)
async def revise_ip_item(batch_id: str, item_id: str, background_tasks: BackgroundTasks) -> dict:
    try:
        item = await app.state.ip_service.revise(batch_id, item_id)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if not item:
        raise HTTPException(status_code=404, detail="章节不存在")
    if not isinstance(app.state.ip_service.store, RedisStore):
        background_tasks.add_task(app.state.ip_service.run_batch, batch_id)
    return {"code": "SUCCESS", "data": item}


@app.post("/internal/ip-content/batches/{batch_id}/items/{item_id}/visuals", status_code=202)
async def create_ip_visuals(
    batch_id: str,
    item_id: str,
    payload: VisualWorkflowRequest,
) -> dict:
    try:
        source = await app.state.ip_service.visual_source(batch_id, item_id)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if source is None:
        raise HTTPException(status_code=404, detail="章节不存在")
    batch, item = source
    current_ref = item.get("visualWorkflow") or {}
    current = service.get_content_workflow(current_ref.get("id")) if current_ref else None
    if current and current.get("status") in {"queued", "running"}:
        raise HTTPException(status_code=409, detail="视觉素材仍在生成，请等待当前任务完成")

    style = IP_VISUAL_STYLES[payload.style]
    workflow = await service.submit_content_workflow({
        "workflowKind": "ip_chapter",
        "subject": f"{batch['ipName']} · {item['title']}",
        "brief": item["brief"],
        "approvedCopy": item["result"]["content"],
        "copyModel": item["result"].get("model") or "人工验收成稿",
        "imageStyles": [style] if "image" in payload.outputs else [],
        "videoStyles": [style] if "video" in payload.outputs else [],
    })
    await app.state.ip_service.attach_visual_workflow(batch_id, item_id, workflow, payload)
    return {"code": "SUCCESS", "message": "视觉生产已启动", "data": workflow}


@app.get("/internal/ip-content/batches/{batch_id}/items/{item_id}/visuals")
async def get_ip_visuals(batch_id: str, item_id: str) -> dict:
    source = await app.state.ip_service.visual_source(batch_id, item_id)
    if source is None:
        raise HTTPException(status_code=404, detail="章节不存在")
    _, item = source
    visual_ref = item.get("visualWorkflow") or {}
    if not visual_ref.get("id"):
        raise HTTPException(status_code=404, detail="章节尚未创建视觉生产任务")
    workflow = service.get_content_workflow(visual_ref["id"])
    if workflow is None:
        raise HTTPException(status_code=410, detail="视觉任务状态已过期，请重新生成")
    return {"code": "SUCCESS", "data": workflow}


@app.get("/health")
def health() -> dict:
    return {
        "code": "SUCCESS",
        "message": "成功",
        "data": {
            "service": settings.service_name,
            "status": "up",
            "mode": "stage-three-bootstrap",
            "modelscopeConfigured": bool(settings.modelscope_api_token),
            "callbackConfigured": bool(settings.callback_base_url),
            "assetsDir": str(settings.assets_dir),
            "ipCheckpoint": "redis" if os.getenv("IP_REDIS_URL", "").strip() else "memory",
            "ipSearchConfigured": bool(os.getenv("BRAVE_SEARCH_API_KEY", "")),
            "agentTeam": "on" if os.getenv("AGENT_TEAM_MODE", "1") != "0" else "off",
            "objectStore": settings.object_store_backend,
            "queue": settings.queue_backend,
            "eval": "on" if settings.eval_enabled else "off",
            "promptOpt": "on" if settings.prompt_opt_enabled else "off",
            "safetyLlm": "on" if settings.safety_llm_enabled else "off",
            "safetyRules": "on",
        },
    }


@app.post("/internal/workflows/generate")
async def generate(payload: WorkflowRequest) -> dict:
    accepted = await service.submit_generation(payload)
    return {
        "code": "SUCCESS",
        "message": "工作流已受理",
        "data": {
            "projectId": payload.project_id,
            "creationRequestId": payload.creation_request_id,
            "taskId": payload.task_id,
            **accepted.model_dump(by_alias=True),
        },
    }


@app.post("/internal/batch-jobs/items")
async def generate_batch_item(payload: dict) -> dict:
    accepted = await service.submit_batch_item(payload)
    return {
        "code": "SUCCESS",
        "message": "批量任务项已受理",
        "data": accepted,
    }


@app.post("/internal/chat")
async def chat(payload: dict) -> dict:
    raw_messages = payload.get("messages") if isinstance(payload, dict) else None
    messages = [
        {
            "role": str(message.get("role") or "user").strip(),
            "content": str(message.get("content") or "").strip(),
        }
        for message in (raw_messages or [])
        if isinstance(message, dict) and str(message.get("content") or "").strip()
    ]
    if not messages:
        raise HTTPException(status_code=400, detail="对话内容不能为空。")

    try:
        result = await service.chat(messages)
    except httpx.TimeoutException as error:
        raise HTTPException(
            status_code=504,
            detail="Agnes 服务响应超时，请稍后重试。",
        ) from error
    except httpx.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail="无法连接 Agnes 服务，请检查网络、代理或 AGNES_BASE_URL。",
        ) from error
    except RuntimeError as error:
        # Provider 未配置密钥或返回了不可用结果，避免前端只能看到笼统的 500。
        raise HTTPException(status_code=502, detail=str(error)) from error

    return {
        "code": "SUCCESS",
        "message": "对话完成",
        "data": result,
    }


@app.post("/internal/content-workflows")
async def submit_content_workflow(payload: dict) -> dict:
    try:
        result = await service.submit_content_workflow(payload or {})
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {
        "code": "SUCCESS",
        "message": "内容工作流已启动",
        "data": result,
    }


@app.get("/internal/content-workflows/{workflow_id}")
def get_content_workflow(workflow_id: str) -> dict:
    result = service.get_content_workflow(workflow_id)
    if result is None:
        raise HTTPException(status_code=404, detail="内容工作流不存在。")
    return {
        "code": "SUCCESS",
        "message": "成功",
        "data": result,
    }


@app.post("/internal/commerce/product-copy")
async def generate_product_copy(payload: dict) -> dict:
    product = payload.get("product") if isinstance(payload, dict) else None
    if not isinstance(product, dict):
        product = payload if isinstance(payload, dict) else {}
    result = await service.generate_product_copy(product)
    return {
        "code": "SUCCESS",
        "message": "Product copy generated",
        "data": result,
    }


@app.get("/internal/workflows/{workflow_task_id}")
def get_workflow(workflow_task_id: str) -> dict:
    run_state = service.get_run(workflow_task_id)
    if run_state is None:
        raise HTTPException(status_code=404, detail="工作流不存在")

    return {
        "code": "SUCCESS",
        "message": "成功",
        "data": run_state.model_dump(by_alias=True, exclude_none=True),
    }
