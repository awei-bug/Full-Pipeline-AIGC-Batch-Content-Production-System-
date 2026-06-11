# LangGraph Generation Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `apps/ai-orchestrator` 的图片/视频生成主链路从手写 `OrchestrationService` 串联逻辑改为真实的 LangGraph 工作流，同时保持现有 FastAPI 接口、Node 回调协议和前端调用方式不变。

**Architecture:** 在 Python 编排层新增 `graphs/` 模块，使用 `StateGraph` 承载请求校验、上下文准备、分流、模型生成、结果整理和回调写回。`OrchestrationService` 只负责创建运行态、启动图执行、同步图执行结果到本地 `WorkflowStore`。`ModelScopeProvider` 和 `CallbackClient` 继续保留为基础设施依赖，由图节点调用。

**Tech Stack:** FastAPI, LangGraph, Pydantic, httpx, unittest

---

> 当前工作区不是 Git 仓库，因此本计划不包含 `git commit` 步骤。

## Files and Responsibilities

- Create: `apps/ai-orchestrator/app/graphs/__init__.py`
- Create: `apps/ai-orchestrator/app/graphs/generation_state.py`
- Create: `apps/ai-orchestrator/app/graphs/generation_graph.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/__init__.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/validate_request.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/prepare_context.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/route_generation.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/generate_image.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/generate_video.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/normalize_outputs.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/emit_success_callback.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/emit_failure_callback.py`
- Modify: `apps/ai-orchestrator/app/services/orchestration_service.py`
- Modify: `apps/ai-orchestrator/app/models.py`
- Create: `apps/ai-orchestrator/tests/test_generation_graph.py`
- Modify: `apps/ai-orchestrator/tests/test_orchestration_service.py`

---

### Task 1: Define LangGraph State and Basic Helpers

**Files:**
- Create: `apps/ai-orchestrator/app/graphs/generation_state.py`
- Modify: `apps/ai-orchestrator/app/models.py`
- Test: `apps/ai-orchestrator/tests/test_generation_graph.py`

- [ ] **Step 1: Write the failing state tests**

```python
from __future__ import annotations

import unittest

from app.graphs.generation_state import (
    build_initial_generation_state,
    is_generation_request_valid,
)
from app.models import WorkflowRequest


class GenerationStateTests(unittest.TestCase):
    def test_build_initial_generation_state_sets_expected_defaults(self):
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="生成一张赛博夜景海报",
            requestType="text_to_image",
            styleCode="cyberpunk",
            aspectRatio="9:16",
        )

        state = build_initial_generation_state("wf_test_001", payload)

        self.assertEqual(state["workflow_task_id"], "wf_test_001")
        self.assertEqual(state["workflow_type"], "text_to_image")
        self.assertEqual(state["provider_code"], "modelscope")
        self.assertEqual(state["current_stage"], "validate_request")
        self.assertEqual(state["progress"], 0)
        self.assertIsNone(state["result"])
        self.assertIsNone(state["error_code"])

    def test_is_generation_request_valid_rejects_blank_prompt(self):
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="   ",
            requestType="text_to_image",
        )

        state = build_initial_generation_state("wf_test_002", payload)

        self.assertFalse(is_generation_request_valid(state))
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd apps/ai-orchestrator
py -m unittest tests.test_generation_graph
```

Expected: FAIL with `ModuleNotFoundError` for `app.graphs.generation_state` or missing functions.

- [ ] **Step 3: Add graph state implementation**

```python
from __future__ import annotations

from typing import Any, TypedDict

from ..models import WorkflowRequest, WorkflowResult


class GenerationGraphState(TypedDict, total=False):
    workflow_task_id: str
    request: WorkflowRequest
    provider_code: str
    workflow_type: str
    current_stage: str
    progress: int
    external_task_id: str | None
    context: dict[str, Any]
    result: WorkflowResult | None
    error_code: str | None
    error_message: str | None
    failed_node: str | None


def build_initial_generation_state(
    workflow_task_id: str,
    payload: WorkflowRequest,
) -> GenerationGraphState:
    return {
        "workflow_task_id": workflow_task_id,
        "request": payload,
        "provider_code": "modelscope",
        "workflow_type": payload.request_type,
        "current_stage": "validate_request",
        "progress": 0,
        "external_task_id": None,
        "context": {},
        "result": None,
        "error_code": None,
        "error_message": None,
        "failed_node": None,
    }


def is_generation_request_valid(state: GenerationGraphState) -> bool:
    payload = state["request"]
    if not payload.prompt.strip():
        return False
    return payload.request_type in {
        "text_to_image",
        "image_to_image",
        "text_to_video",
        "image_to_video",
    }
```

- [ ] **Step 4: Add result-carrying fields to run-state summary model**

```python
class WorkflowRunState(BaseModel):
    workflow_task_id: str = Field(..., alias="workflowTaskId")
    task_id: str = Field(..., alias="taskId")
    creation_request_id: str = Field(..., alias="creationRequestId")
    project_id: str = Field(..., alias="projectId")
    workflow_type: str = Field(..., alias="workflowType")
    provider_code: str = Field(..., alias="providerCode")
    status: str
    progress: int = 0
    accepted_at: datetime = Field(..., alias="acceptedAt")
    started_at: datetime | None = Field(default=None, alias="startedAt")
    finished_at: datetime | None = Field(default=None, alias="finishedAt")
    error_code: str | None = Field(default=None, alias="errorCode")
    error_message: str | None = Field(default=None, alias="errorMessage")
    result_summary: dict[str, Any] | None = Field(default=None, alias="resultSummary")
```

这一段保持原字段不变；如果实际文件已有这部分，则只确认不需要新增别名字段。

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
cd apps/ai-orchestrator
py -m unittest tests.test_generation_graph
```

Expected: `OK`

---

### Task 2: Build LangGraph Nodes and the Main StateGraph

**Files:**
- Create: `apps/ai-orchestrator/app/graphs/generation_graph.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/validate_request.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/prepare_context.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/route_generation.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/generate_image.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/generate_video.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/normalize_outputs.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/emit_success_callback.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/emit_failure_callback.py`
- Test: `apps/ai-orchestrator/tests/test_generation_graph.py`

- [ ] **Step 1: Extend the failing graph test with success and failure paths**

```python
from __future__ import annotations

import unittest

from app.config import Settings
from app.graphs.generation_graph import build_generation_graph
from app.graphs.generation_state import build_initial_generation_state
from app.models import GeneratedOutput, WorkflowRequest, WorkflowResult


class FakeProvider:
    async def generate(self, workflow_task_id, payload, on_progress=None):
        if on_progress:
            await on_progress(60, "处理中", f"external-{workflow_task_id}")
        return WorkflowResult(
            providerCode="modelscope",
            revisedPrompt="重写提示词",
            outputs=[
                GeneratedOutput(
                    assetType="image",
                    storageProvider="local",
                    objectKey="generated/test.png",
                    fileName="test.png",
                    mimeType="image/png",
                    fileSize=128,
                    width=1024,
                    height=1536,
                    metadata={"publicUrl": "/storage/assets/test.png"},
                )
            ],
        )


class FakeFailingProvider:
    async def generate(self, workflow_task_id, payload, on_progress=None):
        raise RuntimeError("provider failed")


class FakeCallbackClient:
    def __init__(self):
        self.events = []

    async def send_task_event(self, payload):
        self.events.append(payload)


class GenerationGraphExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_graph_runs_success_path_for_image_request(self):
        settings = Settings(callback_base_url="http://127.0.0.1:3100")
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="生成一张竖版电影海报",
            requestType="text_to_image",
            styleCode="cinematic",
            aspectRatio="9:16",
        )
        callback_client = FakeCallbackClient()
        graph = build_generation_graph(settings, FakeProvider(), callback_client)

        result = await graph.ainvoke(build_initial_generation_state("wf_test_001", payload))

        self.assertEqual(result["current_stage"], "completed")
        self.assertEqual(result["progress"], 100)
        self.assertIsNotNone(result["result"])
        self.assertEqual(callback_client.events[0].status, "succeeded")

    async def test_graph_runs_failure_path_when_provider_raises(self):
        settings = Settings(callback_base_url="http://127.0.0.1:3100")
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="生成一段夜景视频",
            requestType="text_to_video",
        )
        callback_client = FakeCallbackClient()
        graph = build_generation_graph(settings, FakeFailingProvider(), callback_client)

        result = await graph.ainvoke(build_initial_generation_state("wf_test_002", payload))

        self.assertEqual(result["current_stage"], "failed")
        self.assertEqual(result["failed_node"], "generate_video")
        self.assertEqual(callback_client.events[0].status, "failed")
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd apps/ai-orchestrator
py -m unittest tests.test_generation_graph
```

Expected: FAIL with missing `build_generation_graph` or graph node modules.

- [ ] **Step 3: Implement node modules with clear stage/progress ownership**

Use these node bodies as the plan baseline:

```python
# validate_request.py
from ..generation_state import GenerationGraphState, is_generation_request_valid


async def validate_request_node(state: GenerationGraphState) -> GenerationGraphState:
    next_state = dict(state)
    next_state["current_stage"] = "validate_request"
    next_state["progress"] = 5
    if not is_generation_request_valid(state):
        next_state["error_code"] = "INVALID_WORKFLOW_REQUEST"
        next_state["error_message"] = "请求参数不合法"
        next_state["failed_node"] = "validate_request"
    return next_state
```

```python
# prepare_context.py
from ..generation_state import GenerationGraphState


async def prepare_context_node(state: GenerationGraphState) -> GenerationGraphState:
    payload = state["request"]
    next_state = dict(state)
    next_state["current_stage"] = "prepare_context"
    next_state["progress"] = 12
    next_state["context"] = {
        "style_code": payload.style_code or "cinematic",
        "aspect_ratio": payload.aspect_ratio or "16:9",
        "duration_sec": payload.duration_sec,
    }
    return next_state
```

```python
# route_generation.py
from ..generation_state import GenerationGraphState


def route_generation_node(state: GenerationGraphState) -> str:
    workflow_type = state["workflow_type"]
    if workflow_type in {"text_to_image", "image_to_image"}:
        return "generate_image"
    if workflow_type in {"text_to_video", "image_to_video"}:
        return "generate_video"
    return "emit_failure_callback"
```

- [ ] **Step 4: Implement generate and callback nodes**

```python
# generate_image.py / generate_video.py share this pattern
from ..generation_state import GenerationGraphState


async def generate_image_node(
    state: GenerationGraphState,
    provider,
) -> GenerationGraphState:
    next_state = dict(state)
    next_state["current_stage"] = "generate_image"
    next_state["progress"] = 40

    async def on_progress(progress: int, _note: str, external_task_id: str | None) -> None:
        next_state["progress"] = progress
        next_state["external_task_id"] = external_task_id

    result = await provider.generate(
        state["workflow_task_id"],
        state["request"],
        on_progress=on_progress,
    )
    next_state["result"] = result
    next_state["provider_code"] = result.provider_code
    return next_state
```

```python
# emit_success_callback.py
from ...models import TaskEventPayload


async def emit_success_callback_node(state, callback_client):
    result = state["result"]
    await callback_client.send_task_event(
        TaskEventPayload(
            taskId=state["request"].task_id,
            status="succeeded",
            providerCode=result.provider_code,
            revisedPrompt=result.revised_prompt,
            outputs=result.outputs,
        )
    )
    next_state = dict(state)
    next_state["current_stage"] = "completed"
    next_state["progress"] = 100
    return next_state
```

```python
# emit_failure_callback.py
from ...models import TaskEventPayload


async def emit_failure_callback_node(state, callback_client):
    await callback_client.send_task_event(
        TaskEventPayload(
            taskId=state["request"].task_id,
            status="failed",
            providerCode=state.get("provider_code", "modelscope"),
            errorCode=state.get("error_code"),
            errorMessage=state.get("error_message"),
        )
    )
    next_state = dict(state)
    next_state["current_stage"] = "failed"
    return next_state
```

- [ ] **Step 5: Implement `build_generation_graph()`**

```python
from __future__ import annotations

from langgraph.graph import END, StateGraph

from .generation_state import GenerationGraphState
from .nodes.emit_failure_callback import emit_failure_callback_node
from .nodes.emit_success_callback import emit_success_callback_node
from .nodes.generate_image import generate_image_node
from .nodes.generate_video import generate_video_node
from .nodes.normalize_outputs import normalize_outputs_node
from .nodes.prepare_context import prepare_context_node
from .nodes.route_generation import route_generation_node
from .nodes.validate_request import validate_request_node


def build_generation_graph(settings, provider, callback_client):
    graph = StateGraph(GenerationGraphState)

    graph.add_node("validate_request", validate_request_node)
    graph.add_node("prepare_context", prepare_context_node)
    graph.add_node("generate_image", lambda state: generate_image_node(state, provider))
    graph.add_node("generate_video", lambda state: generate_video_node(state, provider))
    graph.add_node("normalize_outputs", normalize_outputs_node)
    graph.add_node(
        "emit_success_callback",
        lambda state: emit_success_callback_node(state, callback_client),
    )
    graph.add_node(
        "emit_failure_callback",
        lambda state: emit_failure_callback_node(state, callback_client),
    )

    graph.set_entry_point("validate_request")
    graph.add_conditional_edges(
        "validate_request",
        lambda state: "emit_failure_callback" if state.get("error_code") else "prepare_context",
        {
            "prepare_context": "prepare_context",
            "emit_failure_callback": "emit_failure_callback",
        },
    )
    graph.add_conditional_edges(
        "prepare_context",
        route_generation_node,
        {
            "generate_image": "generate_image",
            "generate_video": "generate_video",
            "emit_failure_callback": "emit_failure_callback",
        },
    )
    graph.add_edge("generate_image", "normalize_outputs")
    graph.add_edge("generate_video", "normalize_outputs")
    graph.add_edge("normalize_outputs", "emit_success_callback")
    graph.add_edge("emit_success_callback", END)
    graph.add_edge("emit_failure_callback", END)

    return graph.compile()
```

- [ ] **Step 6: Wrap provider failures into graph-state failures**

Implement the graph nodes so they catch exceptions from provider calls and write:

```python
next_state["error_code"] = getattr(error, "code", "ORCHESTRATOR_FAILED")
next_state["error_message"] = str(error)
next_state["failed_node"] = "generate_image"
```

and return the state so the graph can branch to `emit_failure_callback`.

- [ ] **Step 7: Run tests to verify they pass**

Run:

```bash
cd apps/ai-orchestrator
py -m unittest tests.test_generation_graph
```

Expected: `OK`

---

### Task 3: Integrate LangGraph into OrchestrationService

**Files:**
- Modify: `apps/ai-orchestrator/app/services/orchestration_service.py`
- Modify: `apps/ai-orchestrator/tests/test_orchestration_service.py`
- Test: `apps/ai-orchestrator/tests/test_orchestration_service.py`

- [ ] **Step 1: Replace the current failing service test with graph-based expectations**

```python
class OrchestrationServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_submit_generation_schedules_background_workflow(self):
        settings = Settings(callback_base_url="http://127.0.0.1:3100")
        callback_client = FakeCallbackClient()
        service = OrchestrationService(
            settings,
            provider=FakeProvider(),
            callback_client=callback_client,
            store=WorkflowStore(),
        )

        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="生成一张海报",
            requestType="text_to_image",
            styleCode="cinematic",
            aspectRatio="9:16",
        )

        accepted = await service.submit_generation(payload)

        self.assertEqual(accepted.status, "created")
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        run_state = service.get_run(accepted.workflow_task_id)
        self.assertIsNotNone(run_state)
        self.assertEqual(run_state.status, "success")
        self.assertEqual(run_state.progress, 100)
        self.assertEqual(callback_client.events[0].status, "succeeded")
```

- [ ] **Step 2: Run the service test to verify it fails**

Run:

```bash
cd apps/ai-orchestrator
py -m unittest tests.test_orchestration_service
```

Expected: FAIL because `OrchestrationService` still uses `_run_workflow()` directly instead of the graph.

- [ ] **Step 3: Refactor `OrchestrationService` to own a compiled graph**

Use this structure:

```python
from ..graphs.generation_graph import build_generation_graph
from ..graphs.generation_state import build_initial_generation_state


class OrchestrationService:
    def __init__(self, settings, provider=None, callback_client=None, store=None) -> None:
        self._settings = settings
        self._provider = provider or ModelScopeProvider(settings)
        self._callback_client = callback_client or CallbackClient(settings)
        self._store = store or WorkflowStore()
        self._graph = build_generation_graph(
            settings,
            self._provider,
            self._callback_client,
        )
```

- [ ] **Step 4: Replace `_run_workflow()` with graph execution**

```python
    async def _run_workflow(self, workflow_task_id: str, payload: WorkflowRequest) -> None:
        started_at = datetime.now(timezone.utc)
        self._store.update_run(
            workflow_task_id,
            status="running",
            progress=5,
            startedAt=started_at,
        )

        final_state = await self._graph.ainvoke(
            build_initial_generation_state(workflow_task_id, payload)
        )

        if final_state.get("error_code"):
            self._store.update_run(
                workflow_task_id,
                status="failed",
                progress=final_state.get("progress", 0),
                errorCode=final_state.get("error_code"),
                errorMessage=final_state.get("error_message"),
                finishedAt=datetime.now(timezone.utc),
            )
            return

        result = final_state["result"]
        self._store.update_run(
            workflow_task_id,
            status="success",
            progress=100,
            finishedAt=datetime.now(timezone.utc),
            resultSummary={
                "outputCount": len(result.outputs),
                "providerCode": result.provider_code,
            },
        )
```

- [ ] **Step 5: Keep service-level crash protection around graph invocation**

Wrap `ainvoke()` so truly unexpected graph crashes still send a failure callback:

```python
        try:
            final_state = await self._graph.ainvoke(
                build_initial_generation_state(workflow_task_id, payload)
            )
        except Exception as error:  # noqa: BLE001
            await self._callback_client.send_task_event(
                TaskEventPayload(
                    taskId=payload.task_id,
                    status="failed",
                    providerCode="modelscope",
                    errorCode="ORCHESTRATOR_FAILED",
                    errorMessage=str(error),
                )
            )
            self._store.update_run(
                workflow_task_id,
                status="failed",
                errorCode="ORCHESTRATOR_FAILED",
                errorMessage=str(error),
                finishedAt=datetime.now(timezone.utc),
            )
            return
```

- [ ] **Step 6: Run the updated service test**

Run:

```bash
cd apps/ai-orchestrator
py -m unittest tests.test_orchestration_service
```

Expected: `OK`

---

### Task 4: Full Regression Verification for the Orchestrator Package

**Files:**
- Test: `apps/ai-orchestrator/tests/test_config.py`
- Test: `apps/ai-orchestrator/tests/test_generation_graph.py`
- Test: `apps/ai-orchestrator/tests/test_orchestration_service.py`

- [ ] **Step 1: Run the complete Python test suite**

Run:

```bash
cd apps/ai-orchestrator
py -m unittest discover -s tests
```

Expected:

```text
......
----------------------------------------------------------------------
Ran 6 tests in <time>

OK
```

- [ ] **Step 2: Run Python syntax verification**

Run:

```bash
cd apps/ai-orchestrator
py -m py_compile app\main.py app\models.py app\services\orchestration_service.py app\providers\modelscope.py app\graphs\generation_state.py app\graphs\generation_graph.py
```

Expected: command exits successfully with no output.

- [ ] **Step 3: Manual runtime smoke check**

Run:

```bash
cd apps/ai-orchestrator
py -m uvicorn app.main:app --host 127.0.0.1 --port 8110 --reload
```

In another terminal:

```bash
Invoke-RestMethod http://127.0.0.1:8110/health
```

Expected:

```text
code    message data
----    ------- ----
SUCCESS 成功    ...
```

- [ ] **Step 4: End-to-end workflow smoke check through API server**

With `api-server` already configured to point at `http://127.0.0.1:8110`, submit one generation request from the frontend or via API.

Expected:

- `POST /internal/workflows/generate` returns accepted payload
- the graph reaches success or a provider-originated failure
- success path writes a work into `/api/works`
- failure path writes an error into `/api/tasks/:taskId`

---

## Self-Review

- **Spec coverage:** 覆盖了状态设计、主图节点、条件路由、服务层集成、回调写回和测试策略。
- **Placeholder scan:** 无 `TBD` / `TODO` / “后续补充” 类占位词。
- **Type consistency:** 统一使用 `WorkflowRequest`、`WorkflowResult`、`TaskEventPayload`、`GenerationGraphState` 和 `StateGraph` 作为核心类型与编排接口。
