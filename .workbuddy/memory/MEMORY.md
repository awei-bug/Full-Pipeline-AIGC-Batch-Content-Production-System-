# 项目长期记忆

## 项目定位
`content_create` = AI 跨境电商增长平台（已升级为含多智能体协作层的工程化项目）。
面向工厂外贸部、跨境业务员、品牌团队。主链路：商品导入 → AI 内容（文案/图/视频）→ 推广链接 → 商城支付 → 归因指标。
编排器侧 `app/agents/` 实现 Supervisor + 角色 Agent 的协作闭环，命名中的 Multi-Agent 已落地。

## 代码结构
- `apps/studio-web` React+Vite 工作台（5173）
- `apps/api-server` Node+Express（3100）
- `apps/ai-orchestrator` FastAPI+LangGraph（8110）；`app/agents/` 为真正的多智能体协作层
  （Supervisor + 调研/撰写/润色/审核 角色 Agent、共享记忆、跨 agent 消息、审核失败自主改写闭环）
- `apps/ai-orchestrator/app/` 另有四项生产级增强层（均在 run_item 成稿后执行，异常不中断主链路）：
  `evaluation/`（确定性多维评测 + 提示词自优化，promptProfile 持久化，PROMPT_OPT_ENABLED 默认关）、
  `safety/`（双层审核：规则层始终开，LLM 层 SAFETY_LLM_ENABLED 默认关；失败置 safetyHold）、
  `cost/`（compute_cost + batch.costSummary，COST_PRICING_JSON 可覆盖单价）、
  `storage/`+`queue/`（ObjectStore 本地/S3 抽象、MemoryJobQueue/RedisJobQueue；
  MemoryStore/RedisStore 内嵌队列，worker_loop 两种后端均可）。
- `apps/commerce-api`、`seller-admin`、`storefront` 属于暂存的独立站实验代码，不参与主链路
- 正式商城在 `F:\Python_code\Flask项目`，与本仓库代码和数据库独立，通过 REST + Webhook + 归因字段连接
- DB：PostgreSQL，未配置时回退内存模式

## 模型接入
Agnes（文本/图片主链路）、ModelScope（补位）、OpenAI（视频实验）。

## 启动
`npm run stack:start` / `stack:stop`，`npm run mvp:check` 做全量验证。

### Dev server 网络栈注意
- 在 Bash 工具里用 `run_in_background: true` 直接启动，不要在命令内部再加 `nohup` / `&` / `disown` / `Start-Process` detached
- 否则进程脱离 sandbox 网络栈，present_files 与工具内嵌浏览器看不到，host 上 curl 可能 200 但工具视角不通
- 绑定必须 127.0.0.1；sandbox 拒绝 0.0.0.0

## 与 F:\Python_code\Flask项目 的集成通道
- 直推：`POST /products/import-pack/integration/`，需 `INTEGRATION_TOKENS='slug:token'`，限流 20/分钟
- 自检：`GET /products/import-pack/integration/status/`
- content_create 侧：`POST /api/listing-packs/:jobId/push`，依赖 `COMMERCE_IMPORT_URL/TOKEN/TENANT_SLUG`
- 直推默认 `state=0` 草稿态；`desc_en/sell_points/declare_name_en/declare_name_cn/declare_value/goods_type/hs_code/logistics_note` 已落库（2026-09-08 接通）
- 验证脚本：`scripts/check_descript.py` 跑端到端并断言跨境字段非空

## 关键判断（之前已固化）
- 不合并两项目代码/数据库。中间一根 zip 适配器 + 机器 token 足够
- 半自动优于全自动：AI 生成走草稿态，人工补价 + 一键发布，保留判断权
- 任务回调必须重试：当前 CallbackClient 单次 POST 是 P0 风险
- 旧域（projects/creationRequests/tasks/works/chat）与新域并存，需统一

## 项目定位口径（2026-10-11 与用户确认）
- 严格架构口径（Anthropic《Building Effective Agents》、LangChain 也是「LLM 决定控制流」才算 agent）：
  本项目控制流由代码决定（`route_next` 是纯函数、图结构固定），归 **workflow** 一档；
  其中 `call_stage` 的工具循环是真正的 agentic loop，审核失败改写闭环属于 evaluator-optimizer 模式。
- 行业口径：Gartner 调研（360 位 IT 应用负责人）显示 75% 的组织在试点/部署的是**受监督**形态，
  只有 15% 面向全自主 agent；Gartner 成熟度路线图把「多 agent 协调 + 人类监督」放在 Stage 3，
  而多数所谓 agentic 部署仍在 Stage 2。本项目形态落在 Stage 3 描述附近。
- 结论与建议措辞：对外称「基于 LangGraph 的多角色 agentic workflow，含工具调用、
  evaluator-optimizer 自修正闭环与人工在环治理」，被追问时能讲清控制流归属。
- 若要坐实 agent 标签：需加 planning 节点（运行期由 LLM 拆解任务并动态派发），
  这是唯一能改变分类的改动；其余增强层属治理与基础设施。

## 桌面应用启动（2026-10-11，本地单机的推荐启动方式）
- 桌面只有一个图标 `内容创作平台`（桌面实际重定向在 `D:\工作\Desktop`，开始菜单一份）。
  双击即启动三个服务、弹出独立应用窗口，任务栏托盘同时出现应用图标；**关闭窗口即整体退出**
  （停服务 + 托盘消失 + 清理状态文件）。再次双击不会重复启动，只把已有窗口调到前台。
- 链路：快捷方式 → `app-shell.vbs`（wscript 隐藏调用）→ `scripts/launch-app.ps1`
  → `dev.ps1 content` → 等 studio 就绪 → Chrome/Edge `--app` + 独立 `user-data-dir` 开窗
  → NotifyIcon 托盘驻留 + 每 2 秒轮询该 profile 的浏览器进程。
- npm 命令：`app:install` / `app:install:autostart` / `app:uninstall` / `app:launch` / `app:stop`
  （`app:stop` 是命令行排障入口，桌面不再有「停止」图标）。
- **硬约束**：`app-shell.vbs` 与 `scripts/*-app.ps1` 必须纯 ASCII（无 BOM 的 UTF-8 会被
  PS 5.1 按 GBK 解码），中文显示名用 `New-Text @(0x....)` 码点拼接。
- **硬约束**：实例检测不能依赖命令行内容（不同调用方式下命令行形状不同）。`app-shell.pid`
  记录 **pid + 进程启动时间（yyyyMMddHHmmss）**，两者匹配才算同一实例；pid 文件在启动服务前写入，
  否则快速连击两次会产生两个托盘与两次关停。
- **硬约束**：关窗口只匹配「浏览器进程名 + 完整 profile 路径」；`.local-stack` 状态文件清理一律用
  `[System.IO.File]::Delete()`（`Remove-Item` 可能被工具包装成回收站操作并中断脚本）；
  PowerShell 脚本禁用 `$Pid`/`$PID` 作参数或循环变量名（内置只读，曾致 `Stop-ProcessTree` 静默失效）。
- 图标 `apps/studio-web/public/favicon.ico` 由 `install-app-shortcuts.ps1` 用 System.Drawing 生成。
- 排障：`.local-stack/desktop-launch.log`；详见 `docs/deployment-runbook.md` 第 10 节。

## Windows 启动链路约束（2026-10-11 修复后固化为约定）
- 启动链路：`一键启动.bat` → `npm run local:start` → `dev.ps1 content` → `scripts/start-local-stack.ps1`
  → 三个服务健康检查全过才写 `.local-stack/state.json`；浏览器 URL 取自该文件的 `urls.studio`。
  没有 state.json 就等于某个服务没起来。
- `scripts/*.ps1` 与根 `dev.ps1` 都是**无 BOM 的 UTF-8**，PS 5.1 按 GBK 解码：这些文件必须保持
  纯 ASCII，需要中文时用 `[char]0x...` 拼接（`dev.ps1` 的 shop 路径已有先例）。写中文注释会导致解析失败。
- `Start-Process -ArgumentList` 不自动加引号、按空格拼接；仓库路径含空格，必须传手工拼好的
  单一参数字符串并自行给路径加引号，否则 `-File` 路径在空格处被截断。
- 环境若含仅大小写不同的重复变量（`HTTPS_PROXY` 与 `https_proxy`），`Start-Process` 会抛
  "已添加项。字典中的关键字"。WorkBuddy 沙箱有此重复，用户环境没有。
- 排障入口：`.local-stack/*.err.log`；状态与停止用 `npm run local:status` / `local:stop`。

## 前端与仓库约定（2026-10-11 整理后固化）
- `apps/studio-web/src/styles.css` 是唯一的样式入口，令牌化设计系统（品牌靛紫 `--brand-*`、
  语义色 `--success/--warning/--danger/--info`、`--radius-*`、`--shadow-*`、`--ring`）。
  改样式优先复用令牌，不要写死色值；不要在 body 上写 `min-width`。
- 新增动态类名（如 `tone-*`、`workflow-stage-*`、`workflow-variant-*`、`ip-state-*`、
  `is-*`）必须同步在 styles.css 补齐规则，否则该状态没有视觉反馈。
- 仓库根目录只保留入口与配置；运行日志统一在 `.local-stack/`（gitignored），不要再往根目录丢日志。
- 有引用、不能删：`src/store.js`（scripts/init-postgres.js、reset-generated-data.js 依赖）、
  `data/platform-db.json`（同上）、`db/postgres-init.sql`、`storage/listing-pack-demo.zip`（demo 脚本引用）。
- `apps/commerce-api`、`seller-admin`、`storefront` 是暂存的独立站实验代码：虽然不参与主链路，
  但被根 `package.json` 的 workspaces 引用，不能删或搬移，否则 `npm ci` 会失败。
- 死代码已于 2026-10-11 清理：`App.jsx` 的 `activeStep` 与 `renderImportStep/renderJobStep/
  renderResultStep` 已删除（-335 行）。**遗留待决策**：商品导入 / 任务列表 / 结果浏览 / 打包
  这条外贸流程目前没有任何 UI 入口（打包弹层在渲染树内但打不开），相关处理函数与状态仍在，
  要么接回入口要么整块清理，需用户决定。
- 前端视觉：`styles.css` 使用 `Segoe UI Variable` 优先字族与独立标题字族；两个工作区（数字 IP
  创作、内容工作流）都有 hero 带；微交互在样式表第 10 节。截图基准见 `demo/ui-redesign/`。
- 前端已具备深浅双主题：令牌在 `:root`，深色用 `[data-theme="dark"]` 覆盖；组件只引用令牌，
  禁止写死 `#fff`（品牌渐变上的白字例外）。`src/theme.js` 管偏好，`main.jsx` 渲染前落主题。
- 前端约定补充：字体子集在 `public/fonts/inter-latin.woff2`（`unicode-range` 限定拉丁，
  中文回落系统字体）；插画在 `src/Illustrations.jsx`（内联 SVG + currentColor）；
  章节排序同时支持拖拽与键盘（聚焦手柄 + ↑↓），章节对象带稳定 `id` 供 React 保焦点。
- 本机做前端截图验证用 playwright，必须显式指定
  `%USERPROFILE%\AppData\Local\ms-playwright\chromium-1248\chrome-win64\chrome.exe`
  （node_modules 里的 playwright 期望 1234 版，默认会报可执行文件缺失）。

## 编排器测试环境
- managed venv：`C:/Users/徐炜/.workbuddy/binaries/python/envs/default`，需
  langgraph/langchain/langchain-text-splitters/jieba/rank-bm25/fastapi/uvicorn
- pip 前必须 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，否则清理临时文件被 safe-delete 守卫中断
- 全量：`python -m unittest discover -s tests -p 'test_*.py'`（2026-10-11 为 104 条全绿）
- 评测默认开（确定性、不调模型），提示词自优化与 LLM 安全层默认关，保证默认路径确定
- 评测指标的坑：search_lore 返回带 `[设定片段 N]` 前缀，比对前须剥离；用字符 bigram 覆盖率
