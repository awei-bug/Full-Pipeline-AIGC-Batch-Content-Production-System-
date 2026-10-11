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

## 9. 本地一键启动排障（Windows）

双击根目录 `一键启动.bat` 时，链路是 `npm run local:start` → `dev.ps1 content` →
`scripts/start-local-stack.ps1`。最后一个脚本用 `Start-Process` 以隐藏窗口拉起
`api-server`、`ai-orchestrator`、`studio-web`，三者健康检查全部通过后才写
`.local-stack/state.json`；bat 依据该文件里的 `urls.studio` 打开浏览器。
因此**没有 state.json 就等于某个服务没起来**，此时 bat 会打印最近的 err 日志。

三个已经修复的坑，改动启动脚本时不要回退：

- `Start-Process -ArgumentList` 会把数组按空格拼接，且**不自动给元素加引号**。
  仓库根目录 `内容生成 Multi-Agent 协同编排系统` 含空格，`-File` 的脚本路径会被截断成
  `F:\Python_code\内容生成`，子进程报"该文件不具有 .ps1 扩展名"后立即退出。
  现在的写法是传入手工拼好的单一参数字符串，并自行给路径加引号。
- `scripts/*.ps1` 与根目录 `dev.ps1` 都是**无 BOM 的 UTF-8**，Windows PowerShell 5.1 会按
  系统 ANSI（GBK）解码。这些文件因此必须保持纯 ASCII；需要中文时用 `[char]0x...`
  拼接（`dev.ps1` 里的 shop 路径已有先例），不要直接写中文注释或中文字符串。
- 若进程环境里同时存在 `HTTPS_PROXY` 与 `https_proxy` 这类仅大小写不同的重复变量，
  `Start-Process` 会抛"已添加项。字典中的关键字…"并中断启动。
  先清理重复的环境变量再启动。

排障顺序：看控制台输出 → 看 `.local-stack\*.err.log` → 用 `npm run local:status`
确认各服务状态 → 需要重启时先 `npm run local:stop`。服务已在运行时，
`start-local-stack.ps1` 会直接拒绝重复启动并提示先执行 `npm run stack:stop`。

## 10. 桌面应用启动（本地单机）

`npm run app:install` 创建一个桌面图标（开始菜单一份），双击即启动服务并打开独立应用窗口，
**关闭窗口即整体退出**。用法见根 README「快速开始（桌面应用）」。维护这条链路时有这些硬约束：

- `app-shell.vbs`、`scripts/launch-app.ps1`、`scripts/stop-app.ps1`、
  `scripts/install-app-shortcuts.ps1` 必须保持**纯 ASCII**（同第 9 节的编码约束）。
  中文显示名用 Unicode 码点拼接，例如快捷方式名
  `New-Text @(0x5185,0x5BB9,0x521B,0x4F5C,0x5E73,0x53F0)`。
- 桌面只放**一个**图标：关闭窗口就是退出，不要再加「停止」图标。需要命令行停止时用
  `npm run app:stop`；install 脚本会自动清理旧版留在桌面的停止快捷方式。
- 关闭应用窗口时，匹配条件必须同时限定**浏览器进程名**与**完整 profile 路径**。
  早期版本只判断「命令行里出现 profile 目录名」，会把任何提到该字符串的 PowerShell 进程
  一起杀掉，包括正在执行停止逻辑的父进程，表现为服务停不下来、日志写到一半中断。
- 实例检测**不要依赖命令行内容**（不同启动方式下命令行形状不同，实测脚本内联调用就会漏判）。
  `app-shell.pid` 必须同时记录 **pid 与进程启动时间（yyyyMMddHHmmss）**，两者匹配才算同一实例；
  pid 文件在启动服务之前就要写好，否则双击两次会产生两个托盘与两次关停。
- `.local-stack` 下的状态文件清理一律用 `[System.IO.File]::Delete()` 而不是 `Remove-Item`：
  某些工具会把 `Remove-Item` 包装成回收站操作并在失败时中断脚本，导致后续步骤（关窗口、停服务）
  被跳过。
- PowerShell 脚本里**禁止**用 `$Pid`/`$PID` 作为参数名或循环变量名（内置只读变量）。
  `scripts/local-stack-common.ps1` 曾经因为 `Stop-ProcessTree([int]$Pid)` 参数绑定报错，
  导致「杀进程树」这一步静默失效，只能靠端口兜底。
- 启动器把子进程交给 `start-local-stack.ps1`，因此第 9 节的环境变量重复键问题同样适用：
  环境里若同时存在 `HTTPS_PROXY` 与 `https_proxy`，`Start-Process` 会抛
  「已添加项。字典中的关键字」，此时启动器会弹窗并指向日志。
- 应用图标是生成物：改图纸后必须跑 `python scripts/make-app-icon.py`（需要 Pillow），
  它会重写 `public/favicon.ico` 与 `public/app-icon.ico`，随后 `npm run app:install` 重建快捷方式。
  快捷方式只引用 `app-icon.ico`——Windows 按路径缓存图标，沿用同名文件会让桌面继续显示旧图。

排障入口：`.local-stack/desktop-launch.log`（启动器与停止器的完整 transcript）。
