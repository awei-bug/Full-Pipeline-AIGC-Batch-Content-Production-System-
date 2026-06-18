# AI内容创作平台演进路线图

> 归档说明：这份文档记录的是从旧单体 MVP 向三层架构迁移时的路线图。文中提到的 `src/server.js`、`src/task-orchestrator.js`、`public/app.js` 等路径已退出运行链路，仅保留为历史迁移背景。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前单体 Fastify MVP 演进为基于 React + Express + FastAPI + LangChain/LangGraph 的面向漫剧与内容生产场景的 AI 创作平台。

**Architecture:** 保留当前“生成任务闭环”作为第一批可复用资产，前端重构为 React 工作台，Node 侧拆分为 BFF/API 层，Python 侧承接 AI 编排、多智能体和内容生产工作流，数据库从 JSONB 过渡到结构化 PostgreSQL 模型，逐步补齐项目协作、资产沉淀与项目级配额计费。

**Tech Stack:** React, Express, FastAPI, LangChain/LangGraph, PostgreSQL, Redis, Queue, Object Storage, ModelScope API

---

## 0. 当前现状判断

### 当前仓库已经具备的能力

- React 工作台：`apps/studio-web`
- Node API 服务：`apps/api-server`
- Python AI 编排服务：`apps/ai-orchestrator`
- PostgreSQL / 内存双存储兜底：`src/store.js` 与 `apps/api-server/src/repositories/*`
- 批量商品导入、任务创建、结果导出闭环

### 当前仓库缺失的核心能力

- 项目级权限、团队协作和租户隔离
- 提示词自动评测优化闭环
- Text2SQL 和结构化商品数据库联动
- 审核工作台、人工 review 节点
- Redis / 队列 / WebSocket 或 SSE
- 云端对象存储和生产部署基础设施

### 目标架构

```text
React Studio
    ->
Express API Gateway / BFF
    ->
FastAPI AI Orchestrator
    -> LangGraph workflows
    -> Model providers / postprocess

PostgreSQL + Redis + Queue + Object Storage
```

---

## 1. 总体实施原则

- 先保住当前可运行闭环，再做拆分，不直接推倒重来。
- 先补数据模型和服务边界，再补复杂 agent 工作流。
- 先做“项目化创作平台”，再做“漫剧智能生产平台增强能力”。
- 所有模型调用继续复用现有 provider 设计，但上移到独立 AI 服务。
- Node 负责产品接口与权限，Python 负责工作流与模型编排。

---

## 2. 目标目录规划

### 目标代码布局

```text
apps/
  studio-web/               # React 前端
  api-server/               # Express BFF / API
  ai-orchestrator/          # FastAPI + LangGraph

packages/
  shared-types/             # TS 类型
  shared-config/            # 配置
  prompt-templates/         # 提示词模板

infra/
  sql/
  docker/
  scripts/

storage/
docs/
```

### 当前仓库迁移映射

- `public/` -> `apps/studio-web/`
- `src/routes.js` -> `apps/api-server/src/routes/`
- `src/task-orchestrator.js` -> 拆分为：
  - `apps/api-server/src/services/task-service.ts`
  - `apps/ai-orchestrator/app/workflows/`
- `src/providers/` -> Python AI 服务中的 provider adapter，Node 侧只保留调用接口
- `src/store.js` -> 拆成结构化 repository / migration / schema

---

## 3. 分阶段路线图

## 阶段一：仓库重构与双栈落地

**目标：** 从单体 Fastify MVP 过渡到“React + Express + FastAPI”三层骨架，但不丢掉当前生成能力。

**输出物：**

- React 前端工作台骨架
- Express API 服务骨架
- FastAPI AI 服务骨架
- 现有 Fastify 逻辑迁移清单

- [ ] 建立 `apps/studio-web`，初始化 React 项目
- [ ] 建立 `apps/api-server`，初始化 Express 项目
- [ ] 建立 `apps/ai-orchestrator`，初始化 FastAPI 项目
- [ ] 将现有文档中的目标数据域补成一份 ER 草图
- [ ] 保留当前 `src/` 作为兼容层，不立刻删除
- [ ] 为三层服务定义最小联调接口：
  - `POST /api/projects`
  - `POST /api/creation-requests`
  - `GET /api/tasks/:id`
  - `POST /internal/workflows/generate`
- [ ] 完成本地启动脚本，支持三个服务并行运行

**当前代码处理建议：**

- `src/providers/` 暂时保留，先被 FastAPI 通过 HTTP 或子进程代理复用
- `src/store.js` 暂不继续扩展，只做只读兼容和导出迁移

**验收标准：**

- React 页面可以创建任务
- Express 能转发任务到 FastAPI
- FastAPI 能回调或返回任务状态
- 当前图片/视频生成链路仍可跑通

---

## 阶段二：结构化数据库重建

**目标：** 从当前 JSONB 宽表和 demo user 方案，切换到可支撑项目制内容生产的 PostgreSQL 结构化模型。

**优先落表：**

- `users`
- `projects`
- `project_members`
- `credit_accounts`
- `credit_transactions`
- `creation_requests`
- `generation_tasks`
- `task_status_histories`
- `works`
- `work_versions`
- `media_assets`

- [ ] 新建 `infra/sql/001_init_core_schema.sql`
- [ ] 新建 `infra/sql/002_project_domain.sql`
- [ ] 新建 `infra/sql/003_workflow_domain.sql`
- [ ] 新建 `infra/sql/004_credit_domain.sql`
- [ ] 为 Express 和 FastAPI 分别建立数据库访问层
- [ ] 设计数据迁移脚本，将 `data/platform-db.json` 导出为结构化种子数据
- [ ] 去掉 “演示用户唯一账户” 模型
- [ ] 增加项目、成员、角色权限模型

**必须新增的漫剧业务表：**

- `story_projects`
- `story_characters`
- `story_scenes`
- `story_storyboards`
- `story_shots`
- `story_assets_library`

**验收标准：**

- 创建项目、项目成员、创作请求、任务、作品全链路入库
- 不再依赖 `demo_user`
- 能按项目查询任务、作品、额度消耗

---

## 阶段三：React 工作台替换当前静态前端

**目标：** 把当前“生成表单 + 作品列表”升级为项目制创作工作台。

**首批页面：**

- 登录页
- 项目列表页
- 项目工作台首页
- 剧本工坊页
- 角色设计页
- 分镜页
- 生成中心页
- 资产库页
- 任务监控页

- [ ] 将 `public/index.html` 的核心功能迁移到 React
- [ ] 引入路由、状态管理、接口层
- [ ] 增加项目选择上下文
- [ ] 增加任务实时刷新机制
- [ ] 将作品列表改造为项目资产面板
- [ ] 增加角色卡与场景卡 UI
- [ ] 增加分镜卡片结构，而不是单一 prompt 表单

**当前代码替换点：**

- `public/app.js` 全部淘汰
- `public/app.css` 仅保留临时样式参考

**验收标准：**

- 用户不再直接面对“图片/视频”二选一表单
- 用户以项目为入口管理角色、分镜、生成任务、资产结果

---

## 阶段四：Express API/BFF 业务层成型

**目标：** Node 侧专注业务聚合、权限、项目、配额、资产元数据，不再直接承担 AI 编排。

**职责边界：**

- 用户、项目、成员、权限
- 创作请求入口
- 作品查询与资产聚合
- 额度冻结与结算
- 调用 FastAPI 工作流服务

- [ ] 将现有 `src/routes.js` 拆为模块化路由
- [ ] 增加 `projects`、`characters`、`storyboards`、`assets`、`billing` 路由
- [ ] 增加统一鉴权中间件
- [ ] 增加项目级 quota 校验
- [ ] 增加审计日志与错误码体系
- [ ] 增加 SSE 或 WebSocket 推送任务进度

**必须下沉到 Express 的业务对象：**

- 项目
- 项目成员
- 剧本草稿
- 角色设定
- 分镜草稿
- 任务与作品视图
- 项目级预算和消耗

**验收标准：**

- 所有前端请求都先打到 Express
- Express 不再直接调用模型 provider
- 任务状态和资产查询对前端是稳定契约

---

## 阶段五：FastAPI + LangGraph AI 编排服务

**目标：** 这是整个平台的核心升级点。把当前 `TaskOrchestrator` 升级为真正的多智能体工作流系统。

**首批 LangGraph 工作流：**

- 剧本拆解工作流
- 角色设计工作流
- 分镜生成工作流
- 图片生成工作流
- 视频生成工作流
- 结果质检工作流

**首批 agent 角色：**

- 编剧 Agent
- 导演 Agent
- 分镜 Agent
- 角色设计 Agent
- 提示词优化 Agent
- 审核 Agent

- [ ] 新建 `apps/ai-orchestrator/app/workflows/`
- [ ] 新建 `apps/ai-orchestrator/app/agents/`
- [ ] 建立 LangGraph 状态对象：
  - 项目上下文
  - 剧本上下文
  - 角色上下文
  - 镜头上下文
  - 生成参数上下文
- [ ] 将当前任务状态机迁移为工作流节点推进
- [ ] 增加人工 review 节点
- [ ] 增加失败重试与回退策略
- [ ] 增加 provider adapter，接 ModelScope 图片/视频模型

**当前代码迁移来源：**

- `src/task-orchestrator.js`
- `src/providers/modelscope-image-provider.js`
- `src/providers/modelscope-video-provider.js`

**验收标准：**

- 可以从一个项目分镜节点触发出图
- 可以从角色卡生成角色立绘
- 可以从分镜脚本生成对应图片 prompt
- 可以从镜头描述触发视频生成任务

---

## 阶段六：漫剧生产域补齐

**目标：** 从通用生成平台升级为“漫剧与内容生产平台”。

**需要补齐的业务链路：**

- 项目 -> 章节 -> 分场 -> 镜头
- 镜头 -> 角色引用 -> 场景引用 -> 风格锁定
- 角色一致性资产沉淀
- 场景模板复用
- 分镜转图片
- 图片转视频片段
- 片段汇总为项目资产

- [ ] 增加剧本工坊数据结构和页面
- [ ] 增加角色设定、服装、表情、姿态维度
- [ ] 增加场景模板和镜头模板
- [ ] 增加分镜生成与人工编辑能力
- [ ] 增加镜头级图片/视频结果绑定
- [ ] 增加角色一致性与风格一致性约束

**验收标准：**

- 同一项目内可以管理多个镜头资产
- 同一角色可在多个镜头复用
- 生成结果不再是孤立作品，而是项目资产链的一部分

---

## 阶段七：项目级配额与计费

**目标：** 从“用户 credits”升级为“项目、团队、合作方”可核算的预算体系。

**需要实现的能力：**

- 项目额度账户
- 项目消耗流水
- 团队月度预算
- 不同模型成本系数
- 供应商调用成本记录
- 内部团队与合作方隔离

- [ ] 将当前 `credits.available/frozen/used` 模型升级为账户体系
- [ ] 增加项目级冻结、提交、释放机制
- [ ] 增加按模型、任务类型、时长、张数计费规则
- [ ] 增加账单与成本明细查询
- [ ] 增加项目预算告警

**验收标准：**

- 任务消耗可追溯到项目
- 可以查看某项目本月图片、视频、审核消耗
- 可以控制合作方项目的配额上限

---

## 阶段八：生产级基础设施补齐

**目标：** 让平台从“能跑”进入“可持续运营”。

**必须补齐：**

- Redis
- 消息队列
- 对象存储
- WebSocket/SSE
- 日志、指标、审计
- 任务回调幂等
- 死信队列 / 重试队列

- [ ] 引入 Redis 做任务短态、锁、幂等键
- [ ] 引入队列拆分图片任务和视频任务
- [ ] 引入对象存储，替换本地 `storage/assets`
- [ ] 增加链路追踪和结构化日志
- [ ] 增加任务超时扫描器
- [ ] 增加回调验签和重复回调处理

**验收标准：**

- 服务重启不再把运行中任务直接判失败
- 长视频任务能跨进程恢复
- 资产和元数据都可稳定追踪

---

## 4. 建议实施顺序

### 最优顺序

1. 阶段一：三层骨架
2. 阶段二：结构化数据库
3. 阶段三：React 工作台
4. 阶段四：Express API/BFF
5. 阶段五：FastAPI + LangGraph
6. 阶段六：漫剧生产域
7. 阶段七：项目级配额计费
8. 阶段八：生产级基础设施

### 不建议的顺序

- 不要先做多智能体，再补数据模型
- 不要先做复杂计费，再补项目域
- 不要继续在 `public/app.js` 上叠加漫剧功能
- 不要继续把 orchestrator 留在 Node 单文件里扩张

---

## 5. 从当前仓库起步的第一批实际开发任务

### 第一周

- [ ] 创建 `apps/studio-web`
- [ ] 创建 `apps/api-server`
- [ ] 创建 `apps/ai-orchestrator`
- [ ] 写三服务启动说明
- [ ] 定义统一 `.env` 规范

### 第二周

- [ ] 建 `projects` / `creation_requests` / `generation_tasks` / `works` 表
- [ ] Express 接管当前创作入口
- [ ] FastAPI 接管当前任务编排入口

### 第三周

- [ ] React 实现项目页、任务页、作品页
- [ ] React 接入 Express
- [ ] FastAPI 接入 ModelScope provider

### 第四周

- [ ] 上线第一条 LangGraph 工作流：分镜文本 -> 图片生成
- [ ] 增加角色卡和分镜卡
- [ ] 增加项目级额度冻结/释放

---

## 6. 阶段性里程碑定义

### 里程碑 M1

“从单体 MVP 变成三层应用骨架”

### 里程碑 M2

“从通用生成平台变成项目制创作平台”

### 里程碑 M3

“从项目制创作平台变成漫剧生产平台”

### 里程碑 M4

“从漫剧生产平台变成可运营的企业级协作平台”

---

## 7. 最关键的技术决策

- React 必须替换现有静态前端
- Express 必须承接业务 API 和权限
- FastAPI 必须承接 AI 编排和 provider 调度
- LangGraph 只放在 Python 侧，不要混到 Node
- 当前 provider 逻辑优先迁移，不要重写一遍
- 当前文档已经足够指导数据库和状态机，下一步是落代码，不是再补泛化架构文档

---

## 8. 结论

当前仓库不是废的，真正有价值的是：

- 已有图片/视频 provider 接入方式
- 已有任务闭环和状态推进经验
- 已有架构、数据库、状态机文档基础

但它离目标平台还缺少三层核心中枢：

1. 项目制内容生产模型
2. Python 多智能体工作流引擎
3. 企业级项目配额与资产沉淀体系

下一步执行时，最合理的入口不是继续改 `public/` 和 `src/`，而是从三层骨架与数据库重建开始。
