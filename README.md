# 智能内容创作平台 MVP

这是一个可运行的智能内容创作平台最小版本，支持用户输入提示词后创建异步生成任务，并把生成结果保存到作品列表。

## 当前能力

- 图片生成：已接入魔塔社区接口。配置 `MODELSCOPE_API_TOKEN` 后，图片任务会调用真实图片生成模型。
- 视频生成：当前是本地动图预览链路，用于跑通任务、额度、作品和资源流程；还不是已接入的真实视频生成模型。
- 数据存储：配置 PostgreSQL 后写入数据库；未配置时使用本地 JSON 文件。
- 资源存储：生成文件保存到 `storage/assets`。
- 前端页面：提供中文创作表单、任务进度和作品列表。

## 启动

```bash
npm install
npm start
```

打开：

```text
http://127.0.0.1:3000
```

## PostgreSQL 配置

支持两种数据库配置方式。

方式一：

```bash
DATABASE_URL=postgres://postgres:your_password@127.0.0.1:5432/ai_content_platform
```

方式二：

```bash
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=postgres
PGPASSWORD=your_password
PGDATABASE=ai_content_platform
```

初始化表结构：

```bash
npm run db:init
```

清空已生成任务和作品，保留账户额度：

```bash
npm run data:reset
```

## 魔塔图片生成配置

启动服务前设置：

```bash
MODELSCOPE_API_TOKEN=your_modelscope_token
MODELSCOPE_IMAGE_MODEL=Qwen/Qwen-Image
IMAGE_PROVIDER_MODE=auto
```

模式说明：

- `auto`：有魔塔令牌时优先调用魔塔，失败后使用本地预览兜底。
- `modelscope`：强制优先调用魔塔，运行失败后仍使用本地预览兜底。
- `local`：只使用本地预览生成器。

令牌不要写进代码或提交到仓库。建议放到系统环境变量，再由启动进程读取。

## 核心接口

- `GET /api/v1/health`
- `GET /api/v1/users/me`
- `POST /api/v1/creations/images`
- `POST /api/v1/creations/videos`
- `GET /api/v1/creations/:creationRequestId`
- `GET /api/v1/tasks/:taskId`
- `GET /api/v1/works`
- `POST /api/v1/works/:workId/regenerate`

## 能力边界

图片功能已经是真实落地能力：用户输入提示词后会通过魔塔图片模型生成真实图片结果。

视频功能当前只完成平台流程和本地预览，不是生产级真实视频生成。要落地真实视频，需要继续接入一个可用的视频生成 API，并按现有 provider 接口新增视频供应商实现。
