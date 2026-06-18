# ai-orchestrator

这是当前三层架构里的 Python 编排服务。

当前已经落地两条主要链路：

1. 单任务创作链路
   - 接收 `POST /internal/workflows/generate`
   - 根据任务类型选择图片或视频 provider
   - 轮询模型任务结果并下载本地文件
   - 回调 `api-server` 的 `/internal/orchestrator/task-events`
   - 可通过 `GET /internal/workflows/{workflowTaskId}` 查询本地运行状态

2. 批量商品内容生产链路
   - 接收 `POST /internal/batch-jobs/items`
   - 读取商品上下文
   - 生成营销文案、视频脚本、海报提示词
   - 生成商品配图
   - 回调 `api-server` 的 `/internal/batch-items/events`

## 需要的环境变量

- `MODELSCOPE_API_TOKEN`
- `AGNES_API_KEY`
- `API_SERVER_BASE_URL`，例如 `http://127.0.0.1:3100`
- `MODELSCOPE_IMAGE_MODEL`，默认 `Qwen/Qwen-Image`
- `MODELSCOPE_VIDEO_MODEL`，默认 `wanx2.1-t2v-turbo`
- `AGNES_BASE_URL`，默认 `https://apihub.agnes-ai.com/v1`
- `AGNES_TEXT_MODEL`，默认 `agnes-2.0-flash`
- `AGNES_IMAGE_MODEL`，默认 `agnes-image-2.1-flash`
- `AGNES_VIDEO_MODEL`，默认 `agnes-video-v2.0`
- `AI_ORCHESTRATOR_ASSETS_DIR`，默认 `storage/generated`

可选：

- `MODELSCOPE_BASE_URL`
- `MODELSCOPE_DATA_INSPECTION`
- `AI_TEXT_PROVIDER`
- `AI_IMAGE_PROVIDER`
- `AI_VIDEO_PROVIDER`
- `AI_CREATE_TIMEOUT_SEC`
- `AI_POLL_TIMEOUT_SEC`
- `AI_DOWNLOAD_TIMEOUT_SEC`

## 启动方式

```powershell
cd apps/ai-orchestrator
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8100 --reload
```

## 当前限制

- 视频链路目前仍按实验能力管理，不是当前 MVP 的主验收标准。
- 编排器默认把生成文件落到本地 `storage/generated`，还没有接对象存储。
- 多智能体协作、提示词自动评测优化、安全审核和成本核算还没有放进这条编排链。
