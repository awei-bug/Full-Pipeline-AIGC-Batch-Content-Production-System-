# 阶段一骨架说明

当前仓库已经新增三层目录：

- `apps/studio-web`：React 工作台骨架
- `apps/api-server`：Express 业务 API 骨架
- `apps/ai-orchestrator`：FastAPI + LangGraph 骨架

## 当前兼容策略

- 现有 `src/` 和 `public/` 保留，继续作为旧版单体 MVP
- 新目录先承担阶段一的结构落地，不直接替换旧服务
- 后续迁移顺序：
  1. React 接管前端
  2. Express 接管业务 API
  3. FastAPI 接管 AI 编排

## 当前可用脚本

根目录：

- `npm run legacy:dev`
- `npm run legacy:start`
- `npm run dev:studio`
- `npm run build:studio`
- `npm run dev:api`
- `npm run start:api`
- `npm run db:init:core`

## 新的结构化数据库初始化

阶段二开始后，新的项目制平台数据不再直接复用旧 `public` schema 宽表，而是新增：

- `content_platform.users`
- `content_platform.projects`
- `content_platform.project_members`
- `content_platform.creation_requests`
- `content_platform.generation_tasks`
- `content_platform.works`
- `content_platform.media_assets`
- `content_platform.credit_accounts`

初始化命令：

```bash
npm run db:init:core
```

说明：

- 旧 `npm run db:init` 仍然用于 legacy 单体 MVP 宽表初始化
- 新 `npm run db:init:core` 用于项目制结构化 schema 初始化

## Python 服务启动

当前环境下如果 Python 解释器正常，可进入：

```bash
cd apps/ai-orchestrator
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8100 --reload
```

如果本机 `py` / `python` 仍然损坏，需要先修复 Python 运行时，再启动该服务。
