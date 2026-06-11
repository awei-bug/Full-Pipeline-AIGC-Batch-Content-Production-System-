# AI 内容创作平台 MVP

这是一个面向 AI 内容生产的最小可用版本。当前目标不是完整商业化平台，而是先把“输入文本 -> 调用真实模型 -> 生成图片 -> 页面展示和保存作品记录”这条链路跑稳。

## 当前真实能力

- 文生图：已接入魔塔社区 API。配置 `MODELSCOPE_API_TOKEN` 后，可以生成真实图片并保存到本地资源目录。
- 文生视频：保留前端入口，但标记为“实验中”。当前魔塔视频 API 能创建部分任务，但还没有稳定拿到可播放视频文件，因此不作为 MVP 主流程。
- 前端：React 中文创作界面，只保留输入文本、选择风格/比例、展示最终图片结果。
- API 服务：Express/Fastify 风格的 Node 服务，负责项目、任务、作品、资产记录。
- AI 编排器：FastAPI + LangGraph，负责调用 ModelScope 并回调 API 服务。
- 数据库：支持 PostgreSQL；未配置时仍有本地开发数据能力。

## 本地启动

先安装依赖：

```powershell
cd F:\Python_code\content_create
npm install
```

配置魔塔令牌。令牌不要写入代码或提交到 Git：

```powershell
[Environment]::SetEnvironmentVariable("MODELSCOPE_API_TOKEN", "你的魔塔令牌", "User")
```

重新打开 PowerShell 后确认：

```powershell
$env:MODELSCOPE_API_TOKEN
```

启动本地三服务：

```powershell
npm run stack:start
```

打开前端：

```text
http://127.0.0.1:5173
```

停止服务：

```powershell
npm run stack:stop
```

## 最低验收

每次提交前先跑：

```powershell
npm run mvp:check
```

这个命令会执行：

- Python 编排器单元测试
- Node API 和前端纯逻辑测试
- 前端生产构建
- Git 忽略规则守卫，避免本地密钥、数据库、日志和生成文件进仓库

如果要验证真实图片生成链路，先启动服务，然后跑：

```powershell
npm run stack:smoke:image
```

视频链路目前只做探测，不作为成功验收标准：

```powershell
npm run modelscope:probe-video -- --poll-seconds 0
```

## PostgreSQL

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

初始化表：

```powershell
npm run db:init
```

## 代码边界

当前代码已经覆盖 MVP 底座，但还不是完整平台。尚未完成的能力包括：

- 用户登录、权限和团队空间
- 真实计费、配额和订单
- 剧本工坊、角色设计、分镜生成
- 多智能体协作工作台
- 稳定真实文生视频 provider
- 云端对象存储和生产级部署流水线

## GitHub

本地仓库：

```text
F:\Python_code\content_create
```

远程仓库：

```text
https://github.com/xw2839652081/project
```

常用提交：

```powershell
git add .
git commit -m "说明本次改动"
git push
```
