# LangGraph 生成工作流设计

## 背景

当前 `apps/ai-orchestrator` 已经是一个可运行的 FastAPI 编排服务，但真实执行链路仍然是：

- FastAPI 路由接收请求
- `OrchestrationService` 手工串联流程
- `ModelScopeProvider` 直接执行图片/视频生成
- `CallbackClient` 回调 Node API

仓库虽然已经安装了 `langchain` 和 `langgraph`，但当前实现中没有真正使用它们承载工作流编排。这次改造的目标，是把“图片/视频生成主链路”迁移为真正的 LangGraph 工作流，同时保持现有 API 协议和前端调用方式不变。

## 目标

将当前生成链路重构为一条基于 LangGraph 的主图工作流，覆盖：

- 请求校验
- 生成上下文准备
- 图片/视频分流
- 模型调用
- 结果整理
- 成功回调
- 失败回调

改造完成后，`ai-orchestrator` 可以明确定位为：

- FastAPI：对外 API 层
- LangGraph：工作流编排层
- Provider / Callback：基础设施调用层

## 非目标

这次不包含以下内容：

- 多 Agent 协作
- LangChain Prompt Chain
- 剧本工坊、角色设计、分镜生成等新工作流
- Redis / PostgreSQL 持久化 LangGraph checkpoint
- 人工审核节点
- 自动重试策略
- Node API 或前端接口重构

## 现状与问题

当前实现的主要问题：

1. 工作流逻辑全部堆在 `OrchestrationService` 中，扩展节点时会继续膨胀。
2. 图片和视频虽然已经按 provider 分支，但没有显式图结构，不利于后续插入新节点。
3. 失败处理依赖 service 层兜底，缺少统一的图状态语义。
4. 依赖虽然已安装，但 `LangGraph` 没有真正落地，后续规划文档和代码现状不一致。

## 设计原则

1. **保持接口稳定**
   - `POST /internal/workflows/generate`
   - `GET /internal/workflows/{workflowTaskId}`
   - Node API 回调协议保持不变。

2. **只在 Python 编排层引入 LangGraph**
   - Node API 保持 Express 结构不变。
   - `LangGraph` 只放在 `apps/ai-orchestrator`。

3. **编排与调用分层**
   - 图节点负责业务步骤编排。
   - Provider 负责调用外部模型。
   - Callback client 负责回调写回。

4. **为后续扩展预留位置**
   - 本轮只落一条主图。
   - 状态结构和节点组织按后续可扩展方向设计。

## 总体架构

### 对外入口

- FastAPI 路由继续接收生成请求
- `OrchestrationService` 负责创建 `workflow_task_id` 与本地运行态
- 后台异步执行 LangGraph 主图

### 图工作流层

新增 `graphs/` 目录，承载：

- 状态模型
- 主图构建逻辑
- 节点实现
- 条件路由

### 基础设施层

继续复用：

- `ModelScopeProvider`
- `CallbackClient`
- `WorkflowStore`

这三层关系：

```text
FastAPI -> OrchestrationService -> LangGraph
LangGraph -> Provider / CallbackClient
OrchestrationService -> WorkflowStore
```

## 文件结构设计

建议新增以下文件：

```text
apps/ai-orchestrator/app/
  graphs/
    __init__.py
    generation_state.py
    generation_graph.py
    nodes/
      __init__.py
      validate_request.py
      prepare_context.py
      route_generation.py
      generate_image.py
      generate_video.py
      normalize_outputs.py
      emit_success_callback.py
      emit_failure_callback.py
```

职责说明：

- `generation_state.py`
  - 定义 LangGraph 状态对象
  - 提供状态初始化和最少量辅助函数

- `generation_graph.py`
  - 创建 `StateGraph`
  - 声明入口节点、条件边、成功结束和失败结束

- `validate_request.py`
  - 校验请求参数
  - 生成失败状态字段

- `prepare_context.py`
  - 补齐默认值
  - 生成统一上下文，供图片和视频分支共用

- `route_generation.py`
  - 决定走图片节点还是视频节点

- `generate_image.py`
  - 调用图片生成 provider 能力

- `generate_video.py`
  - 调用视频生成 provider 能力

- `normalize_outputs.py`
  - 统一结果结构
  - 输出 `WorkflowResult`

- `emit_success_callback.py`
  - 成功回调 Node API

- `emit_failure_callback.py`
  - 失败回调 Node API

## 状态设计

LangGraph 状态需要覆盖运行所需的最小闭环。建议包含：

- `workflow_task_id`
- `request`
- `provider_code`
- `workflow_type`
- `current_stage`
- `progress`
- `external_task_id`
- `result`
- `error_code`
- `error_message`
- `failed_node`

状态语义：

- `request`：原始 `WorkflowRequest`
- `result`：最终 `WorkflowResult | None`
- `failed_node`：发生故障的节点名
- `external_task_id`：魔塔任务号

这样后续即使加提示词重写、审核、重试节点，也不需要重做状态结构。

## 工作流设计

### 主图节点

主图的执行顺序：

```text
validate_request
  -> prepare_context
  -> route_generation
     -> generate_image
     -> generate_video
  -> normalize_outputs
  -> emit_success_callback
  -> END
```

失败分支：

```text
任意节点异常
  -> 写入 error_code / error_message / failed_node
  -> emit_failure_callback
  -> END
```

### 路由规则

- `text_to_image` / `image_to_image` -> `generate_image`
- `text_to_video` / `image_to_video` -> `generate_video`
- 其他类型 -> `validate_request` 阶段直接失败

## 进度与阶段设计

本轮保留已有进度语义，但改为节点驱动：

- `validate_request`：5
- `prepare_context`：12
- `route_generation`：18
- `generate_image` / `generate_video`：40-75
- `normalize_outputs`：85
- `emit_success_callback`：95
- 完成：100

这样前端即使不展示详细任务状态，后端运行态和调试语义也更清晰。

## 错误处理设计

错误处理统一遵循：

1. 节点内部允许抛异常
2. 图执行层统一捕获
3. 将错误写入 graph state：
   - `error_code`
   - `error_message`
   - `failed_node`
4. 统一进入 `emit_failure_callback`

优点：

- 错误出口统一
- `OrchestrationService` 不需要知道每个节点的失败细节
- 便于后续加入重试和人工介入逻辑

## 与现有代码的集成方式

### `OrchestrationService`

`OrchestrationService` 调整为运行入口服务：

- 创建本地运行态
- 启动 LangGraph
- 读取最终 graph state
- 更新 `WorkflowStore`

它不再自己顺序串联 provider 和 callback。

### `ModelScopeProvider`

继续保留 provider 层职责，不改为图本体：

- 继续负责图片/视频生成
- 继续负责下载和整理原始文件
- 作为图节点依赖被调用

### `CallbackClient`

保持不变：

- 成功节点调用
- 失败节点调用

## 测试策略

本轮测试分三层：

### 1. 图状态和分支测试

验证：

- 图片请求进入图片分支
- 视频请求进入视频分支
- 非法请求进入失败分支

### 2. 图执行回归测试

使用 fake provider + fake callback client：

- 成功路径最终得到 `success`
- 失败路径最终得到 `failed`
- 成功时有成功回调
- 失败时有失败回调

### 3. 服务层集成测试

验证：

- `submit_generation()` 能启动 LangGraph
- 图执行完成后 `WorkflowStore` 状态正确更新

## 实施边界

这次改造只保证：

- 当前图片/视频生成主链路真正运行在 LangGraph 上
- 现有外部接口不变
- 当前前端无需改接口
- 当前 Node API 回调逻辑可继续复用

改造完成后，可以明确说明：

- 依赖不再只是“装了”
- `LangGraph` 已经承载真实业务流程
- 当前已落地第一条生产工作流
- 但尚未进入多智能体平台阶段

## 风险与控制

主要风险：

1. 改造过程中打断当前可跑链路
2. 图状态和现有 `WorkflowStore` 状态语义不一致
3. 成功/失败回调节点职责不清导致重复逻辑

控制方式：

- 保持外部接口不变
- 先以最小主图替换现有手工串联逻辑
- 测试先覆盖成功/失败双路径，再切换主入口

## 结论

推荐方案是：

- 用 LangGraph 重构当前生成主链路
- 只改 Python 编排层
- 保持 Node API 和前端接口稳定
- 采用单主图 + 节点分文件的方式
- 预留后续插入提示词重写、审核、重试节点的能力

这是当前阶段风险最低、收益最高的落地方式。
