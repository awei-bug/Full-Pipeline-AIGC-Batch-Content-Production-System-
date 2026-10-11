# Agnes Provider 接入约定

> 最后核对日期：2026-09-09。协议变化时请优先重新核对 Agnes 官方文档。

官方入口：

- 总览：https://www.agnes-ai.com/zh-Hans/docs/overview
- Video V2.0：https://www.agnes-ai.com/zh-Hans/docs/agnes-video-v20

## 当前固定模型

- 文案/聊天：`agnes-2.5-flash`
- 图片：`agnes-image-2.5-flash`
- 视频：`agnes-video-v2.0`

所有调用只允许发生在 `apps/ai-orchestrator` 的 Provider 层，前端不得持有或传递 `AGNES_API_KEY`。

## 公共配置

- Base URL：`https://apihub.agnes-ai.com/v1`
- 认证头：`Authorization: Bearer <AGNES_API_KEY>`
- JSON 请求：`Content-Type: application/json`

## 文案生成

- 创建请求：`POST /v1/chat/completions`
- OpenAI 兼容的 `model + messages` 请求格式
- 非流式正文读取：`choices[0].message.content`

## 图片生成

- 创建请求：`POST /v1/images/generations`
- 当前文生图请求使用：
  - `size: "1K"`
  - `ratio`: 使用工作流画幅，如 `1:1`、`16:9`、`9:16`
  - `extra_body.response_format: "url"`
- 图片结果优先读取 `data[0].url`，同时兼容 `data[0].b64_json`。
- `response_format` 不得放在请求顶层。

## 视频生成

- 创建请求：`POST /v1/videos`
- 文生视频固定使用：
  - `model: "agnes-video-v2.0"`
  - `width` / `height`: 由工作流画幅映射到 720p 尺寸
  - `frame_rate: 24`
  - `num_frames`: 根据 `durationSec` 换算，并规范为 `8n+1`
- 官方限制：
  - `num_frames` 最大为 `441`
  - 实际时长为 `num_frames / frame_rate`
- 创建响应优先保存 `video_id`；`id` / `task_id` 是任务 ID，不应代替 `video_id`。
- 推荐轮询接口位于 API 根路径而不是 `/v1` 下：
  - `GET https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>&model_name=agnes-video-v2.0`
- 轮询到 `status=completed` 后，从 `metadata.url` 下载视频。
- `status=failed` 时读取响应中的错误信息并终止任务。

## 验证命令

```powershell
cd F:\Python_code\content_create
npm run mvp:check
```

真实接口冒烟测试可能产生外部 API 消耗，不纳入默认自动测试；执行前应确认账户额度和调用意图。
