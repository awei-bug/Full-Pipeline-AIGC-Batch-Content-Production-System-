# MVP 落地验收清单

本文档用于判断当前项目是否达到“可演示、可继续部署”的最小可用状态。

## 必须通过

- `npm run mvp:check` 通过。
- `npm run stack:start` 能同时启动 API 服务、AI 编排器和前端。
- 前端地址 `http://127.0.0.1:5173` 能打开。
- 页面默认进入“文生图”模式。
- 输入文本后可以提交图片生成任务。
- 生成中显示“图片正在生成中”。
- 任务成功后右侧展示最终图片。
- 生成结果保存为作品和资产记录。
- `.local-stack/`、`data/platform-db.json`、`storage/`、`*.db`、`*.log` 不进入 Git。

## 真实图片链路验收

前置条件：

- 系统环境变量已配置 `MODELSCOPE_API_TOKEN`。
- PostgreSQL 已启动并初始化，或使用本地开发存储。
- 本地三服务已经启动。

执行：

```powershell
npm run stack:smoke:image
```

通过标准：

- 命令输出 `taskStatus` 为 `success`。
- 输出中包含 `workId`。
- 输出中包含 `firstAssetPublicUrl`。
- 浏览器可以打开生成的资源地址。

## 当前不作为 MVP 通过标准

- 文生视频生成可播放成片。视频可以单独验收，但不阻塞图片 MVP。
- 账号登录和权限。
- 团队协作。
- 配额计费。
- 剧本、角色、分镜和多智能体生产流。
- 生产环境 HTTPS 域名部署。

## 视频能力当前状态

视频入口保留为实验能力。当前支持两条路线：

- 魔塔路线：`Wan-AI/Wan2.1-T2V-1.3B` 能通过魔塔 API 创建任务，但任务可能长时间保持 `RUNNING`，没有稳定返回视频 URL。
- OpenAI 路线：配置 `OPENAI_API_KEY` 后，AI 编排器可以走 OpenAI Videos API 创建、轮询并下载视频结果。

## OpenAI 视频实验验收

前置条件：

- 系统环境变量已配置 `OPENAI_API_KEY`。
- OpenAI API 账号有视频模型权限和可用余额。
- 本地三服务已经通过 `npm run stack:start` 启动。
- 前端显示“文生视频（实验中）”并允许提交。

执行：

```powershell
npm run stack:smoke:video
```

通过标准：

- 命令输出 `taskStatus` 为 `success`。
- 输出中包含 `workId`。
- 输出中包含 `firstAssetPublicUrl`。
- 浏览器可以播放返回的视频资源。

如果失败，先查看：

```powershell
Get-Content .local-stack\ai-orchestrator.err.log
```

视频失败不影响图片 MVP。等视频稳定后，再把它从“实验中”升级为正式能力。
