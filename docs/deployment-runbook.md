# AI 内容创作平台部署运行手册

本文档针对当前仓库的现状，给出一套可以落地的部署方式。当前推荐架构仍然是三段式：

- `studio-web`：React + Vite 前端，构建后产出静态文件
- `api-server`：Node/Express 业务 API，负责项目、任务、作品与回调入库
- `ai-orchestrator`：FastAPI + LangGraph 编排服务，负责调用魔塔模型并回调 `api-server`

## 1. 推荐部署拓扑

最稳妥的线上拓扑：

- Nginx
  - `/` -> 前端静态文件
  - `/api/` -> `api-server`
  - `/storage/assets/` -> `api-server` 暴露的生成资源
- `api-server`：监听 `127.0.0.1:3100`
- `ai-orchestrator`：监听 `127.0.0.1:8110`
- PostgreSQL：监听 `127.0.0.1:5432`

这样前端只需要配置一个对外域名，浏览器不会碰到跨域和多端口暴露问题。

## 2. 服务器前置条件

- Node.js 20+
- Python 3.12+
- PostgreSQL 14+
- 已配置 `MODELSCOPE_API_TOKEN`
- 服务器可访问魔塔模型接口

## 3. 必要环境变量

### api-server

至少需要：

```bash
API_HOST=127.0.0.1
API_PORT=3100
AI_ORCHESTRATOR_BASE_URL=http://127.0.0.1:8110
AI_ORCHESTRATOR_ASSETS_DIR=/opt/ai-content-platform/storage/generated
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=postgres
PGPASSWORD=your_password
PGDATABASE=ai_content_platform
```

### ai-orchestrator

至少需要：

```bash
MODELSCOPE_API_TOKEN=your_modelscope_token
API_SERVER_BASE_URL=http://127.0.0.1:3100
AI_ORCHESTRATOR_ASSETS_DIR=/opt/ai-content-platform/storage/generated
MODELSCOPE_IMAGE_MODEL=Qwen/Qwen-Image
MODELSCOPE_VIDEO_MODEL=Wan-AI/Wan2.1-T2V-1.3B
MODELSCOPE_DATA_INSPECTION={"input":false,"output":false}
```

### studio-web

构建时需要：

```bash
VITE_API_BASE_URL=https://your-domain.com
```

如果前端和 API 都挂在同一个域名下，也可以继续直接写线上域名根地址。

## 4. 首次部署步骤

### 4.1 安装依赖

在仓库根目录执行：

```bash
npm install
cd apps/ai-orchestrator
py -m pip install -r requirements.txt
cd ../..
```

### 4.2 初始化数据库

```bash
npm run db:init
```

如果数据库还不存在，先创建：

```sql
CREATE DATABASE ai_content_platform;
```

### 4.3 构建前端

```bash
npm run build:studio
```

构建产物目录：

- `apps/studio-web/dist`

### 4.4 启动后端服务

#### 启动 api-server

```bash
npm run start:api
```

#### 启动 ai-orchestrator

```bash
npm run dev:orchestrator
```

线上建议不要用 `--reload`。更稳妥的正式命令：

```bash
cd apps/ai-orchestrator
py -m uvicorn app.main:app --host 127.0.0.1 --port 8110
```

## 5. Nginx 反向代理示例

```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /opt/ai-content-platform/apps/studio-web/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /internal/ {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /storage/assets/ {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 6. 建议的进程托管

不要手工开窗口运行。线上建议用：

- Linux：`systemd`
- Windows Server：NSSM 或计划任务 + 服务封装

最少要托管两个长期进程：

- `api-server`
- `ai-orchestrator`

## 7. 发布后检查

至少检查这几个接口：

```bash
curl http://127.0.0.1:3100/api/health
curl http://127.0.0.1:8110/health
```

然后做一条真实任务验证：

```bash
npm run stack:smoke:image
```

如果要验证视频链路：

```bash
npm run stack:smoke:video
```

如果需要重新筛选魔塔文生视频模型，先跑探测脚本：

```bash
npm run modelscope:probe-video -- --poll-seconds 0
```

指定候选模型：

```bash
npm run modelscope:probe-video -- --poll-seconds 0 --models "Wan-AI/Wan2.1-T2V-1.3B,AI-ModelScope/stepvideo-t2v-turbo"
```

探测结果说明：

- `accepted`：模型能被 `/videos/generations` 接收，并返回了 `task_id`
- `running_timeout`：模型能提交，但在探测窗口内没有完成
- `succeeded`：模型在探测窗口内返回了视频地址
- `create_failed`：模型不能通过当前 API-Inference 视频接口调用

## 8. 当前能力边界

当前线上可以认为已经真实落地的部分：

- 文生图：真实调用魔塔模型
- 文生视频：已接入魔塔视频链路；当前验证结果显示 `Wan-AI/Wan2.1-T2V-1.3B` 能提交并返回 `task_id`，但长时间保持 `RUNNING`，还未拿到最终视频地址
- 编排：Python 侧已切到 LangGraph
- 数据回写：`api-server` 已能把成功/失败结果落到任务与作品数据

当前仍建议继续补的部分：

- 视频模型筛选、专项重试与超时策略
- 统一日志与 trace id
- 生产级进程守护配置
- 前端构建产物自动发布
