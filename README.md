# Full Pipeline AIGC Batch Content Production System

面向商家、自媒体和内容生产团队的全链路 AIGC 批量内容生产系统。

这个项目不是单条提示词试玩工具，而是一个可落地的批量生产工作台：导入商品数据后，系统会按商品批量生成营销文案、短视频脚本、海报提示词和效果图，并支持结果预览与导出。

## 演示

- Web 工作台：`http://127.0.0.1:5173`
- API 服务：`http://127.0.0.1:3100`
- AI 编排器：`http://127.0.0.1:8110`

演示视频和封面：

![项目预览](demo/preview.png)

- 演示视频文件：[`demo/demo.mp4`](demo/demo.mp4)

## 项目能力

当前版本已经打通这些能力：

- 批量导入商品数据
  - 支持 `CSV / XLSX / XLS`
  - 自动识别常见商品字段
- 批量创建内容任务
  - 以商品批次为单位发起生产任务
- 多阶段内容生成
  - 营销文案
  - 视频脚本
  - 海报提示词
  - 效果图片
- 结果工作台
  - 中文界面
  - 任务状态查看
  - 图片预览
  - 结果导出 Excel
- 持久化存储
  - PostgreSQL 已接通
- AI 提供方接入
  - Agnes 文本/图片链路
  - 魔塔社区链路补位
  - OpenAI 视频链路保留实验入口

## 当前真实边界

这个仓库当前是一个可运行的 MVP，不是完整商业平台。还没有完成的部分包括：

- 用户登录、权限、团队空间、租户隔离
- 真实计费、配额、订单和结算
- Text2SQL 商品数据库联动
- 提示词自动评测和自优化闭环
- 内容安全审核双层拦截
- 稳定生产级视频生成链路
- 对象存储、队列、生产级部署和观测

## 系统架构

当前代码结构是三层：

```text
apps/
  studio-web/         React + Vite 中文工作台
  api-server/         Node + Express API 服务
  ai-orchestrator/    FastAPI + LangGraph 编排服务

infra/sql/            PostgreSQL 结构化表
scripts/              本地栈、初始化、检查脚本
storage/generated/    本地生成产物
demo/                 README 演示素材
```

职责分工：

- `studio-web`
  - 商品导入
  - 批量任务发起
  - 结果浏览和导出
- `api-server`
  - 批次、商品、任务、结果、导出
  - PostgreSQL 持久化
  - 对外统一 API
- `ai-orchestrator`
  - 单商品内容流水线
  - 文案/脚本/提示词/图片生成
  - 回调 API 服务落库

## 主要技术栈

- 前端：React、Vite
- API：Node.js、Express
- 编排：FastAPI、LangGraph
- 数据库：PostgreSQL
- 文件处理：XLSX
- 多媒体：FFmpeg
- 模型接入：
  - Agnes API
  - ModelScope API
  - OpenAI API（实验性视频入口）

## 启动前准备

### 1. 安装依赖

```powershell
cd F:\Python_code\content_create
npm install
```

Python 侧依赖：

```powershell
cd apps/ai-orchestrator
py -m pip install -r requirements.txt
```

### 2. 配置模型密钥

推荐优先使用 Agnes：

```powershell
[Environment]::SetEnvironmentVariable("AGNES_API_KEY", "你的 Agnes API Key", "User")
```

如果不用 Agnes，可配置魔塔：

```powershell
[Environment]::SetEnvironmentVariable("MODELSCOPE_API_TOKEN", "你的魔塔令牌", "User")
```

如需实验视频能力，可再配：

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "你的 OpenAI API Key", "User")
```

重新打开终端后确认：

```powershell
$env:AGNES_API_KEY
$env:MODELSCOPE_API_TOKEN
$env:OPENAI_API_KEY
```

### 3. 配置 PostgreSQL

创建数据库：

```powershell
psql -h 127.0.0.1 -U postgres -d postgres -c "CREATE DATABASE ai_content_platform;"
```

设置连接变量：

```powershell
$env:PGHOST="127.0.0.1"
$env:PGPORT="5432"
$env:PGUSER="postgres"
$env:PGPASSWORD="你的数据库密码"
$env:PGDATABASE="ai_content_platform"
```

初始化结构化表：

```powershell
node scripts/init-core-schema.js
```

## 本地启动

推荐直接用本地栈脚本：

```powershell
npm run stack:start
```

启动后以 `.local-stack/state.json` 为准查看当前地址。

停止：

```powershell
npm run stack:stop
```

## 核心 API

### 导入商品批次

`POST /api/import-batches`

### 查询批次列表

`GET /api/import-batches`

### 查询商品列表

`GET /api/products?batchId=...`

### 创建批量任务

`POST /api/content-jobs`

### 查询任务列表

`GET /api/content-jobs`

### 查询结果列表

`GET /api/content-outputs?jobId=...`

### 导出结果

`GET /api/content-exports/:jobId`

### 健康检查

`GET /api/health`

## 验证命令

提交前最低建议执行：

```powershell
npm run mvp:check
```

这个命令会检查：

- Python 编排器单元测试
- Node API 测试
- 前端测试
- 本地栈脚本测试
- 前端构建

真实图片链路 smoke：

```powershell
npm run stack:smoke:image
```

## 当前仓库状态

当前本地已经验证过：

- 前端工作台可访问
- API 服务可访问
- AI 编排器可访问
- PostgreSQL 已接通
- 图片结果能落库并在前端预览

## 仓库说明

这个仓库当前对应的是一套“全链路 AIGC 批量内容生产系统 MVP”实现，不再是早期的单体静态页生成器。

如果你要继续往企业级方向推进，下一阶段最值得做的是：

- 用户和权限体系
- 批量任务队列化
- 内容安全审核
- 成本统计和配额
- 云端对象存储
- 视频链路生产化
