# MVP 落地验收清单

本文档用于判断当前项目是否达到“可演示、可继续部署”的最小可用状态。

## 必须通过

- `npm run mvp:check` 通过。
- `npm run stack:start` 能同时启动 API 服务、AI 编排器和前端。
- 前端地址 `http://127.0.0.1:5173` 能打开。
- 页面默认进入外贸批量内容工作台。
- 可导入 CSV / XLSX 产品数据。
- 可勾选内容类型并创建批量任务。
- 任务进行中显示生成中状态，并自动刷新进度。
- 任务成功后展示英文 Listing / 开发信 / 产品图提示词 / 效果图。
- 可导出 Excel 结果。
- `.local-stack/`、`data/platform-db.json`、`storage/`、`*.db`、`*.log` 不进入 Git。

## 真实图片链路验收

前置条件：

- 系统环境变量已配置 `AGNES_API_KEY` 或 `MODELSCOPE_API_TOKEN`。
- PostgreSQL 已启动并初始化，或使用本地内存模式。
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

- 文生视频生成可播放成片。视频可单独验收，不阻塞图片 / 批量内容 MVP。
- 账号登录和权限。
- 团队协作。
- 配额计费。
- 剧本、角色、分镜和多智能体生产流。
- 生产环境 HTTPS 域名部署。

## 已冻结项（2026-12，阶段 0）

以下能力已从本清单的验收口径中移除，**代码与测试保留**，但不再作为 MVP 通过标准或对外演示内容：

- 剧本、角色、分镜和多智能体生产流（对应「数字 IP 创作」工作区）— 已冻结，见
  [阶段0-电商无关能力冻结清单.md](../../电商垂类整合计划/阶段0-电商无关能力冻结清单.md)。
- IP 工作区相关测试（`apps/api-server/src/routes/ip-content.test.js`）— 保留运行，不计入对外验收。

电商批量内容链路（商品导入 → 按类型生成 → 导出 / 推送）**继续作为本项目验收核心**。

## 视频能力当前状态

视频入口保留为实验能力。当前支持：

- 魔塔路线：`Wan-AI/Wan2.1-T2V-1.3B` 能创建任务，但可能长时间 `RUNNING`。
- OpenAI 路线：配置 `OPENAI_API_KEY` 后可走 OpenAI Videos API。

## OpenAI 视频实验验收

前置条件：

- 系统环境变量已配置 `OPENAI_API_KEY`。
- OpenAI API 账号有视频模型权限和可用余额。
- 本地三服务已经通过 `npm run stack:start` 启动。

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

视频失败不影响批量内容 MVP。
