from __future__ import annotations

from fastapi import FastAPI, HTTPException

from .config import Settings
from .models import WorkflowRequest
from .services.orchestration_service import OrchestrationService


settings = Settings.from_env()
service = OrchestrationService(settings)
app = FastAPI(title="智能编排服务", version="0.3.0")


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
