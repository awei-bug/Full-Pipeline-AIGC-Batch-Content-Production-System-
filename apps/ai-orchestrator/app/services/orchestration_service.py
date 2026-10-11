from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from ..config import Settings
from ..graphs.batch_generation_graph import build_batch_generation_graph
from ..graphs.batch_generation_state import build_initial_batch_state
from ..graphs.generation_graph import build_generation_graph
from ..graphs.generation_state import build_initial_generation_state
from ..models import (
    TaskEventPayload,
    WorkflowAccepted,
    WorkflowRequest,
    WorkflowRunState,
)
from ..providers.generation_provider import GenerationProvider
from .callback_client import CallbackClient


class WorkflowStore:
    def __init__(self) -> None:
        self._runs: dict[str, WorkflowRunState] = {}

    def create_run(self, payload: WorkflowRunState) -> None:
        self._runs[payload.workflow_task_id] = payload

    def update_run(self, workflow_task_id: str, **changes: Any) -> WorkflowRunState | None:
        current = self._runs.get(workflow_task_id)
        if current is None:
            return None
        next_payload = current.model_copy(update=changes)
        self._runs[workflow_task_id] = next_payload
        return next_payload

    def get_run(self, workflow_task_id: str) -> WorkflowRunState | None:
        return self._runs.get(workflow_task_id)


class OrchestrationService:
    def __init__(
        self,
        settings: Settings,
        provider: GenerationProvider | None = None,
        callback_client: CallbackClient | None = None,
        store: WorkflowStore | None = None,
    ) -> None:
        self._settings = settings
        self._provider = provider or GenerationProvider(settings)
        self._callback_client = callback_client or CallbackClient(settings)
        self._store = store or WorkflowStore()
        self._content_workflows: dict[str, dict[str, Any]] = {}
        self._graph = build_generation_graph(
            settings,
            self._provider,
            self._callback_client,
        )
        self._batch_graph = build_batch_generation_graph(self._provider)

    async def submit_generation(self, payload: WorkflowRequest) -> WorkflowAccepted:
        now = datetime.now(timezone.utc)
        workflow_task_id = f"wf_{uuid4().hex[:12]}"
        provider_code = self._provider_code_for(payload)
        run_state = WorkflowRunState(
            workflowTaskId=workflow_task_id,
            taskId=payload.task_id,
            creationRequestId=payload.creation_request_id,
            projectId=payload.project_id,
            workflowType=payload.request_type,
            providerCode=provider_code,
            status="created",
            progress=0,
            acceptedAt=now,
        )
        self._store.create_run(run_state)
        asyncio.create_task(self._run_workflow(workflow_task_id, payload))
        return WorkflowAccepted(
            workflowTaskId=workflow_task_id,
            workflowType=payload.request_type,
            providerCode=provider_code,
            status="created",
            acceptedAt=now.isoformat(),
        )

    async def submit_batch_item(self, payload: dict[str, Any]) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        workflow_task_id = f"wf_{uuid4().hex[:12]}"
        job_item_id = StringLike(payload.get("jobItemId")).value
        run_state = WorkflowRunState(
            workflowTaskId=workflow_task_id,
            taskId=job_item_id or workflow_task_id,
            creationRequestId=str(payload.get("jobId") or workflow_task_id),
            projectId=str(payload.get("productId") or "batch-project"),
            workflowType="batch_content_item",
            providerCode="batch",
            status="created",
            progress=0,
            acceptedAt=now,
        )
        self._store.create_run(run_state)
        asyncio.create_task(self._run_batch_item(workflow_task_id, payload))
        return {
            "workflowTaskId": workflow_task_id,
            "jobItemId": job_item_id,
            "status": "created",
        }

    def get_run(self, workflow_task_id: str) -> WorkflowRunState | None:
        return self._store.get_run(workflow_task_id)

    async def chat(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        return await self._provider.chat(messages)

    async def submit_content_workflow(self, payload: dict[str, Any]) -> dict[str, Any]:
        brief = str(payload.get("brief") or "").strip()
        if not brief:
            raise ValueError("创作需求不能为空。")
        approved_copy = str(payload.get("approvedCopy") or "").strip()
        copy_model = str(payload.get("copyModel") or "").strip()
        workflow_kind = str(payload.get("workflowKind") or "campaign").strip()
        subject = str(payload.get("subject") or "").strip()

        image_styles = self._normalize_workflow_styles(payload.get("imageStyles"))
        video_styles = self._normalize_workflow_styles(payload.get("videoStyles"))
        if not image_styles and not video_styles:
            raise ValueError("至少选择一种图片或视频风格。")

        now = datetime.now(timezone.utc).isoformat()
        workflow_id = f"cw_{uuid4().hex[:12]}"
        state = {
            "id": workflow_id,
            "status": "queued",
            "progress": 0,
            "currentStage": "copy",
            "brief": brief,
            "approvedCopy": approved_copy,
            "copyModel": copy_model,
            "workflowKind": workflow_kind,
            "subject": subject,
            "copy": None,
            "imageVariants": [],
            "videoVariants": [],
            "imageStyles": image_styles,
            "videoStyles": video_styles,
            "stages": [
                {
                    "id": "copy",
                    "label": (
                        "提炼视觉开发摘要"
                        if workflow_kind == "ip_chapter"
                        else "使用已确认宣传文案" if approved_copy else "生成内容底稿"
                    ),
                    "status": "queued",
                    "progress": 0,
                },
                {"id": "images", "label": f"批量生成图片 · {len(image_styles)} 种风格", "status": "pending", "progress": 0},
                {"id": "videos", "label": f"批量生成视频 · {len(video_styles)} 种风格", "status": "pending", "progress": 0},
                {"id": "complete", "label": "汇总可发布内容", "status": "pending", "progress": 0},
            ],
            "createdAt": now,
            "updatedAt": now,
            "errorMessage": None,
        }
        self._content_workflows[workflow_id] = state
        asyncio.create_task(self._run_content_workflow(workflow_id))
        return state

    def get_content_workflow(self, workflow_id: str) -> dict[str, Any] | None:
        return self._content_workflows.get(str(workflow_id or "").strip())

    @staticmethod
    def _normalize_workflow_styles(raw_styles: Any) -> list[dict[str, str]]:
        styles = []
        for index, raw_style in enumerate(raw_styles or []):
            if isinstance(raw_style, dict):
                style_id = str(raw_style.get("id") or f"style-{index + 1}").strip()
                label = str(raw_style.get("label") or raw_style.get("name") or style_id).strip()
                prompt = str(raw_style.get("prompt") or label).strip()
            else:
                style_id = f"style-{index + 1}"
                label = str(raw_style or "").strip()
                prompt = label
            if label and prompt:
                styles.append({"id": style_id, "label": label, "prompt": prompt})
        return styles[:8]

    def _update_content_workflow(self, workflow_id: str, **changes: Any) -> dict[str, Any] | None:
        state = self._content_workflows.get(workflow_id)
        if state is None:
            return None
        state.update(changes)
        state["updatedAt"] = datetime.now(timezone.utc).isoformat()
        return state

    def _set_content_stage(
        self,
        workflow_id: str,
        stage_id: str,
        *,
        status: str,
        progress: int,
        current_stage: str | None = None,
    ) -> None:
        state = self._content_workflows.get(workflow_id)
        if state is None:
            return
        stages = []
        for stage in state.get("stages", []):
            next_stage = dict(stage)
            if next_stage.get("id") == stage_id:
                next_stage.update({"status": status, "progress": progress})
            stages.append(next_stage)
        changes: dict[str, Any] = {"stages": stages, "progress": progress}
        if current_stage:
            changes["currentStage"] = current_stage
        self._update_content_workflow(workflow_id, **changes)

    async def _run_content_workflow(self, workflow_id: str) -> None:
        state = self._content_workflows.get(workflow_id)
        if state is None:
            return

        self._update_content_workflow(workflow_id, status="running", currentStage="copy")
        self._set_content_stage(workflow_id, "copy", status="running", progress=8, current_stage="copy")
        brief = state["brief"]
        approved_copy = str(state.get("approvedCopy") or "").strip()
        workflow_kind = str(state.get("workflowKind") or "campaign")
        subject = str(state.get("subject") or "").strip()
        if workflow_kind == "ip_chapter":
            try:
                copy_result = await self._build_ip_visual_brief(
                    subject=subject,
                    brief=brief,
                    chapter=approved_copy,
                )
            except Exception as error:  # noqa: BLE001
                self._set_content_stage(workflow_id, "copy", status="failed", progress=8, current_stage="copy")
                self._update_content_workflow(workflow_id, status="failed", errorMessage=str(error))
                return
        elif approved_copy:
            copy_result = {
                "content": approved_copy,
                "model": str(state.get("copyModel") or "用户确认文案"),
                "provider": "studio",
            }
        else:
            try:
                copy_result = await self._provider.chat(
                    [
                        {
                            "role": "system",
                            "content": (
                                "你是内容工作流主编。根据用户需求，生成一份可直接用于社交媒体、图片和视频生产的中文内容底稿。"
                                "请包含：核心主题、主标题、正文、画面主体、镜头动作和结尾行动号召。"
                                "短视频脚本按8秒设计，最多包含3个画面节拍。"
                                "不要解释过程，直接输出完整底稿。"
                            ),
                        },
                        {"role": "user", "content": brief},
                    ]
                )
            except Exception as error:  # noqa: BLE001
                self._set_content_stage(workflow_id, "copy", status="failed", progress=8, current_stage="copy")
                self._update_content_workflow(
                    workflow_id,
                    status="failed",
                    errorMessage=str(error),
                )
                return

        state = self._content_workflows[workflow_id]
        state["copy"] = copy_result
        self._set_content_stage(workflow_id, "copy", status="success", progress=25, current_stage="images")

        image_styles = state.get("imageStyles", [])
        video_styles = state.get("videoStyles", [])
        copy_text = str((copy_result or {}).get("content") or "").strip()

        if image_styles:
            self._set_content_stage(workflow_id, "images", status="running", progress=28, current_stage="images")
            image_variants = []
            for index, style in enumerate(image_styles):
                variant = await self._run_content_asset_variant(
                    workflow_id=workflow_id,
                    kind="image",
                    index=index,
                    style=style,
                    brief=brief,
                    copy_text=copy_text,
                    workflow_kind=workflow_kind,
                    subject=subject,
                )
                image_variants.append(variant)
                progress = 28 + round(((index + 1) / len(image_styles)) * 32)
                self._update_content_workflow(workflow_id, imageVariants=image_variants, progress=progress)
            self._set_content_stage(workflow_id, "images", status="success", progress=60, current_stage="videos")
        else:
            self._set_content_stage(workflow_id, "images", status="skipped", progress=25, current_stage="videos")

        if video_styles:
            self._set_content_stage(workflow_id, "videos", status="running", progress=63, current_stage="videos")
            video_variants = []
            for index, style in enumerate(video_styles):
                variant = await self._run_content_asset_variant(
                    workflow_id=workflow_id,
                    kind="video",
                    index=index,
                    style=style,
                    brief=brief,
                    copy_text=copy_text,
                    workflow_kind=workflow_kind,
                    subject=subject,
                )
                video_variants.append(variant)
                progress = 63 + round(((index + 1) / len(video_styles)) * 32)
                self._update_content_workflow(workflow_id, videoVariants=video_variants, progress=progress)
            self._set_content_stage(workflow_id, "videos", status="success", progress=95, current_stage="complete")
        else:
            self._set_content_stage(workflow_id, "videos", status="skipped", progress=60, current_stage="complete")

        state = self._content_workflows[workflow_id]
        variants = state.get("imageVariants", []) + state.get("videoVariants", [])
        failed_count = sum(1 for item in variants if item.get("status") == "failed")
        final_status = "partial_success" if failed_count else "success"
        self._set_content_stage(workflow_id, "complete", status="success", progress=100, current_stage="complete")
        self._update_content_workflow(workflow_id, status=final_status, progress=100, currentStage="complete")

    async def _run_content_asset_variant(
        self,
        *,
        workflow_id: str,
        kind: str,
        index: int,
        style: dict[str, str],
        brief: str,
        copy_text: str,
        workflow_kind: str = "campaign",
        subject: str = "",
    ) -> dict[str, Any]:
        variant_id = f"{workflow_id}_{kind}_{index + 1}"
        request_type = "text_to_image" if kind == "image" else "text_to_video"
        if workflow_kind == "ip_chapter":
            prompt = await self._build_ip_generation_prompt(
                kind=kind,
                subject=subject,
                visual_brief=copy_text,
                style=style,
            )
        elif kind == "video":
            prompt = await self._build_video_generation_prompt(
                brief=brief,
                copy_text=copy_text,
                style=style,
            )
        else:
            prompt = (
                f"最终确认宣传文案（最高优先级，必须完整遵循）：\n{copy_text}\n\n"
                f"原始创作需求（仅用于补充背景，不得覆盖最终确认文案）：\n{brief}\n\n"
                f"本次分支风格：{style['label']}。{style['prompt']}\n"
                "请生成一张适合社交媒体发布的商业视觉，主体清晰，画面留出标题区域。"
            )
        try:
            request = WorkflowRequest(
                projectId=workflow_id,
                creationRequestId=workflow_id,
                taskId=variant_id,
                prompt=prompt,
                requestType=request_type,
                styleCode=style["id"],
                aspectRatio=("16:9" if workflow_kind == "ip_chapter" else "1:1" if kind == "image" else "9:16"),
                durationSec=8 if kind == "video" else None,
            )
            result = await self._provider.generate(variant_id, request)
            output = result.outputs[0].model_dump(by_alias=True) if result.outputs else None
            if output is None:
                raise RuntimeError("模型没有返回可用素材。")
            return {
                "id": variant_id,
                "style": style,
                "status": "success",
                "generationPrompt": prompt,
                "output": output,
            }
        except Exception as error:  # noqa: BLE001
            return {
                "id": variant_id,
                "style": style,
                "status": "failed",
                "generationPrompt": prompt,
                "errorMessage": str(error),
            }

    async def _build_ip_visual_brief(
        self,
        *,
        subject: str,
        brief: str,
        chapter: str,
    ) -> dict[str, Any]:
        result = await self._provider.chat([
            {
                "role": "system",
                "content": (
                    "你是游戏与数字IP的视觉开发编辑。只依据已验收章节选择一个最具叙事价值、"
                    "适合转为单幅关键帧和8秒连续镜头的场景。输出中文视觉摘要，包含场景时刻、"
                    "地点、角色外观与服装、动作、关键道具、光线氛围和必须保持一致的设定锚点。"
                    "不得增加正文中没有依据的人物、事件或世界观事实，控制在600字以内。"
                ),
            },
            {
                "role": "user",
                "content": f"作品与章节：{subject}\n章节目标：{brief[:1000]}\n已验收正文：\n{chapter[:9000]}",
            },
        ])
        content = str((result or {}).get("content") or "").strip()
        if not content:
            raise RuntimeError("模型没有返回视觉开发摘要")
        return {
            "content": content[:3000],
            "model": str((result or {}).get("model") or "视觉开发模型"),
            "provider": str((result or {}).get("provider") or "llm"),
        }

    async def _build_ip_generation_prompt(
        self,
        *,
        kind: str,
        subject: str,
        visual_brief: str,
        style: dict[str, str],
    ) -> str:
        media_instruction = (
            "Write one production-ready English text-to-image prompt for a cinematic 16:9 narrative keyframe. "
            "Specify composition, character continuity, environment, action, lighting and camera language."
            if kind == "image"
            else "Write one production-ready English text-to-video prompt for one continuous 8-second 16:9 shot. "
            "Use one location, at most two characters, one clear action and restrained camera movement."
        )
        result = await self._provider.chat([
            {
                "role": "system",
                "content": (
                    "You are a visual development prompt director for games and narrative IP. "
                    f"{media_instruction} Preserve every supplied continuity anchor. Do not invent plot facts. "
                    "No montage, scene cuts, morphing, duplicate characters, on-screen text, subtitles, logos or watermark. "
                    "Output only the final English prompt, between 80 and 160 words."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"IP chapter: {subject}\n"
                    f"Approved visual brief:\n{visual_brief[:3000]}\n"
                    f"Art direction: {style['label']}. {style['prompt']}"
                ),
            },
        ])
        prompt = str((result or {}).get("content") or "").strip()
        if not prompt:
            raise RuntimeError("模型没有返回视觉生成提示词")
        if prompt.startswith("```") and prompt.endswith("```"):
            prompt = prompt.strip("`").strip()
        return prompt[:2200]

    async def _build_video_generation_prompt(
        self,
        *,
        brief: str,
        copy_text: str,
        style: dict[str, str],
    ) -> str:
        fallback_prompt = self._fallback_video_generation_prompt(
            brief=brief,
            copy_text=copy_text,
            style=style,
        )
        try:
            result = await self._provider.chat(
                [
                    {
                        "role": "system",
                        "content": (
                            "You are a commercial text-to-video prompt director for Agnes Video V2.0. "
                            "Convert the supplied campaign material into one concise English generation prompt. "
                            "Output only the final prompt, without markdown or explanation. "
                            "Design exactly one continuous 8-second vertical 9:16 shot in one location, "
                            "with at most one person and one main product action. Explicitly define the product's "
                            "fixed shape, color, material, lid, handle and visible details, and require them to "
                            "remain identical from first to last frame. Include realistic camera movement, "
                            "lighting and natural motion. Do not use scene cuts, montage, morphing, duplicate "
                            "products, on-screen text, subtitles, logos, watermarks or visualized numeric claims. "
                            "Keep the result between 80 and 140 English words."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            f"Campaign brief:\n{brief[:800]}\n\n"
                            f"Approved copy:\n{copy_text[:2400]}\n\n"
                            f"Visual style: {style['label']}. {style['prompt']}"
                        ),
                    },
                ]
            )
        except Exception:  # noqa: BLE001
            return fallback_prompt

        prompt = str((result or {}).get("content") or "").strip()
        if not prompt:
            return fallback_prompt
        if prompt.startswith("```") and prompt.endswith("```"):
            prompt = prompt.strip("`").strip()
            if prompt.lower().startswith("text"):
                prompt = prompt[4:].strip()
        return prompt[:1800]

    @staticmethod
    def _fallback_video_generation_prompt(
        *,
        brief: str,
        copy_text: str,
        style: dict[str, str],
    ) -> str:
        product_context = " ".join((brief or copy_text[:500]).split())
        return (
            "8-second vertical 9:16 commercial product video. "
            f"Product context: {product_context[:600]}. "
            f"Visual style: {style['label']}; {style['prompt']}. "
            "Use one continuous shot in one realistic location with at most one person. "
            "Show one simple action: naturally pick up and gently rotate the product toward the camera. "
            "Keep the exact same product silhouette, color, material, lid, handle and proportions in every frame. "
            "Natural handheld camera movement, soft commercial lighting, realistic hands and physics. "
            "No cuts, montage, morphing, duplicate products, added or missing parts, text, subtitles, logos or watermark."
        )

    async def generate_product_copy(self, product: dict[str, Any]) -> dict[str, Any]:
        """Synchronous English listing content for commerce products."""
        payload = {
            "name": product.get("name") or product.get("title") or "Export Product",
            "sellingPoint": product.get("sellingPoint")
            or product.get("description")
            or "Quality export product",
            "category": product.get("category") or "General",
            "audience": product.get("audience")
            or product.get("targetMarket")
            or "Overseas buyers",
            "scenario": product.get("scenario")
            or product.get("application")
            or "B2B wholesale",
            "price": product.get("price") or "FOB negotiable",
        }
        copy = await self._provider.generate_copy(payload)
        title = str(copy.get("title") or payload["name"]).strip()
        body = str(copy.get("body") or "").strip()
        selling_points = copy.get("sellingPoints") or []
        if isinstance(selling_points, list) and selling_points and not body:
            body = "\n".join(
                f"- {str(point).strip()}" for point in selling_points if str(point).strip()
            )

        return {
            "title": title,
            "description": body,
            "sellingPoints": selling_points if isinstance(selling_points, list) else [],
            "generationMeta": copy.get("generationMeta")
            or {
                "source": "commerce_product_copy",
                "fallbackUsed": False,
            },
        }

    async def _run_workflow(
        self,
        workflow_task_id: str,
        payload: WorkflowRequest,
    ) -> None:
        started_at = datetime.now(timezone.utc)
        self._store.update_run(
            workflow_task_id,
            status="running",
            progress=5,
            started_at=started_at,
        )

        try:
            final_state = await self._graph.ainvoke(
                build_initial_generation_state(
                    workflow_task_id,
                    payload,
                    provider_code=self._provider_code_for(payload),
                )
            )
        except Exception as error:  # noqa: BLE001
            await self._handle_failure(
                workflow_task_id,
                payload.task_id,
                getattr(error, "code", "ORCHESTRATOR_FAILED"),
                str(error),
                self._provider_code_for(payload),
            )
            return

        finished_at = datetime.now(timezone.utc)
        if final_state.get("error_code"):
            self._store.update_run(
                workflow_task_id,
                status="failed",
                progress=final_state.get("progress", 0),
                finished_at=finished_at,
                error_code=final_state.get("error_code"),
                error_message=final_state.get("error_message"),
            )
            return

        result = final_state["result"]
        self._store.update_run(
            workflow_task_id,
            status="success",
            progress=final_state.get("progress", 100),
            finished_at=finished_at,
            result_summary={
                "outputCount": len(result.outputs),
                "providerCode": result.provider_code,
            },
        )

    async def _run_batch_item(
        self,
        workflow_task_id: str,
        payload: dict[str, Any],
    ) -> None:
        started_at = datetime.now(timezone.utc)
        self._store.update_run(
            workflow_task_id,
            status="running",
            progress=5,
            started_at=started_at,
        )

        try:
            final_state = await self._batch_graph.ainvoke(
                build_initial_batch_state(
                    workflow_task_id=workflow_task_id,
                    job_item=payload,
                )
            )
        except Exception as error:  # noqa: BLE001
            callback = getattr(self._callback_client, "send_batch_item_event", None)
            if callable(callback):
                await callback(
                    {
                        "jobItemId": StringLike(payload.get("jobItemId")).value,
                        "status": "failed",
                        "errorCode": "BATCH_ITEM_FAILED",
                        "errorMessage": str(error),
                    }
                )
            self._store.update_run(
                workflow_task_id,
                status="failed",
                error_code="BATCH_ITEM_FAILED",
                error_message=str(error),
                finished_at=datetime.now(timezone.utc),
            )
            return

        callback = getattr(self._callback_client, "send_batch_item_event", None)
        if callable(callback):
            await callback(
                {
                    "jobItemId": StringLike(payload.get("jobItemId")).value,
                    "status": "succeeded",
                    "outputs": final_state.get("outputs", []),
                    "usage": {
                        "estimatedTokens": 0,
                        "estimatedCost": 0,
                    },
                    "riskStatus": "degraded" if final_state.get("degraded") else "passed",
                    "warnings": final_state.get("warnings", []),
                }
            )

        self._store.update_run(
            workflow_task_id,
            status="success",
            progress=100,
            finished_at=datetime.now(timezone.utc),
            result_summary={
                "jobItemId": StringLike(payload.get("jobItemId")).value,
                "status": final_state.get("status", "success"),
                "outputCount": len(final_state.get("outputs", [])),
                "degraded": bool(final_state.get("degraded")),
            },
        )

    async def _handle_failure(
        self,
        workflow_task_id: str,
        task_id: str,
        error_code: str,
        error_message: str,
        provider_code: str,
    ) -> None:
        try:
            await self._callback_client.send_task_event(
                TaskEventPayload(
                    taskId=task_id,
                    status="failed",
                    providerCode=provider_code,
                    errorCode=error_code,
                    errorMessage=error_message,
                )
            )
        finally:
            self._store.update_run(
                workflow_task_id,
                status="failed",
                error_code=error_code,
                error_message=error_message,
                finished_at=datetime.now(timezone.utc),
            )

    def _provider_code_for(self, payload: WorkflowRequest) -> str:
        if payload.request_type.strip() in {"text_to_video", "image_to_video"}:
            return self._settings.video_provider
        if payload.request_type.strip() in {"text_to_image", "image_to_image"}:
            return self._settings.image_provider
        return self._settings.image_provider


class StringLike:
    def __init__(self, value: Any) -> None:
        self.value = str(value or "").strip()
