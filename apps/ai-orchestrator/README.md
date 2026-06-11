# ai-orchestrator

这是当前三层架构里的 Python 编排服务。

当前已经补到下面这条最小链路：

- 接收 `POST /internal/workflows/generate`
- 根据任务类型选择魔塔图片或视频生成
- 轮询模型任务结果并下载本地文件
- 回调 `api-server` 的 `/internal/orchestrator/task-events`
- 可通过 `GET /internal/workflows/{workflowTaskId}` 查询本地运行状态

## 需要的环境变量

- `MODELSCOPE_API_TOKEN`
- `API_SERVER_BASE_URL`，例如 `http://127.0.0.1:3100`
- `MODELSCOPE_IMAGE_MODEL`，默认 `Qwen/Qwen-Image`
- `MODELSCOPE_VIDEO_MODEL`，默认 `wanx2.1-t2v-turbo`
- `AI_ORCHESTRATOR_ASSETS_DIR`，默认 `storage/generated`

可选：

- `MODELSCOPE_BASE_URL`
- `MODELSCOPE_DATA_INSPECTION`
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

- 这台机器上的 Python 运行时目前不可用，所以这里的代码还没有做本机实际启动验证。
- `api-server` 侧的回调接口和作品落库已经联调过，Python 侧当前重点是把调用链补齐。
