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

- 文生视频生成可播放成片。
- 账号登录和权限。
- 团队协作。
- 配额计费。
- 剧本、角色、分镜和多智能体生产流。
- 生产环境 HTTPS 域名部署。

## 视频能力当前状态

视频入口保留为实验能力。当前验证过的情况是：

- `Wan-AI/Wan2.1-T2V-1.3B` 能通过魔塔 API 创建任务。
- 多个其它文生视频模型会返回 `Invalid model provider`。
- 已接受的视频任务可能长时间保持 `RUNNING`，没有稳定返回视频 URL。

因此视频不再阻塞 MVP 图片生成闭环。等找到稳定 provider 后，再把视频从“实验中”升级为正式能力。
