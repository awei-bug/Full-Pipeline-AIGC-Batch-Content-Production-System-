# AI内容创作平台任务状态机设计

## 1. 文档目的

本文档基于以下文档继续细化 AI 内容创作平台的一期任务编排机制：

- 《AI内容创作平台整体架构说明》
- 《AI内容创作平台微服务拆分说明》
- 《AI内容创作平台核心数据库设计》
- 《AI内容创作平台核心接口设计》

本文档聚焦以下内容：

- 任务状态机的设计目标
- 核心任务对象与状态定义
- 状态流转规则
- 关键事件与触发条件
- 回调、重试、超时、取消和失败补偿处理
- 与额度结算、作品生成、审核流程的联动规则

本文档的目标不是描述通用工作流引擎，而是定义本平台一期可直接实施的任务流转规范。

## 2. 设计目标

任务状态机必须解决以下问题：

- 长耗时图片和视频生成任务如何稳定跟踪
- 外部模型回调不稳定时如何保证一致性
- 失败、超时、重复回调、用户取消如何处理
- 何时冻结额度、何时确认消耗、何时退回
- 何时生成作品、何时对用户可见
- 如何保证任务历史可审计、可排障

## 3. 状态机适用范围

本状态机主要适用于以下任务：

- 文生图任务
- 图生图任务
- 文生视频任务
- 图生视频任务
- 生成后的后处理任务

说明：

- 一期建议将“生成任务”作为主状态机对象
- 后处理可以作为主任务下的阶段，也可以在实现上拆成子任务
- 为控制复杂度，本文档优先按“单主任务 + 阶段推进”的模型设计

## 4. 核心对象定义

### 4.1 创作请求

创作请求是用户发起的一次业务动作，对应数据库中的 `creation_requests`。

职责：

- 作为前端主要跟踪对象
- 记录用户输入和业务状态
- 聚合一个或多个任务的最终结果

### 4.2 生成任务

生成任务是平台编排执行的核心对象，对应数据库中的 `generation_tasks`。

职责：

- 承载异步执行生命周期
- 记录模型执行、后处理、审核等推进状态
- 驱动额度结算和作品生成

### 4.3 任务历史

任务历史对应 `task_status_histories`，用于记录所有关键状态迁移。

职责：

- 审计
- 排障
- 运营追踪
- 异常恢复分析

## 5. 状态机设计原则

### 5.1 主状态精简

任务主状态不宜过多，否则：

- 业务理解成本高
- 接口语义变得不稳定
- 运维和排障困难

一期建议使用少量主状态，再通过 `current_stage` 表达细粒度阶段。

### 5.2 状态单向推进为主

除重试、取消和异常恢复场景外，任务状态应尽量单向推进，避免复杂回退。

### 5.3 用户可见状态与内部执行状态分离

前端看到的状态应该相对稳定，例如：

- 排队中
- 生成中
- 后处理中
- 审核中
- 已完成
- 失败

内部则允许保留更细的阶段值。

### 5.4 写操作必须幂等

以下事件必须幂等：

- 创建任务
- 模型执行结果回调
- 状态迁移
- 额度提交
- 额度释放
- 作品落库

## 6. 主状态定义

建议 `generation_tasks.status` 使用以下状态：

| 状态 | 含义 | 是否终态 |
|---|---|---|
| `created` | 任务已创建，尚未正式入队 | 否 |
| `queued` | 已进入调度队列，等待执行 | 否 |
| `running` | 模型推理或处理中 | 否 |
| `post_processing` | 模型已返回，进入后处理 | 否 |
| `reviewing` | 进入生成后审核 | 否 |
| `success` | 全流程完成并成功产出结果 | 是 |
| `failed` | 流程失败，无法继续推进 | 是 |
| `cancelled` | 用户或系统取消任务 | 是 |

说明：

- `success`、`failed`、`cancelled` 为终态
- 终态后除补充审计信息外，不允许再流转到非终态

## 7. 阶段定义

建议 `generation_tasks.current_stage` 记录以下细粒度阶段：

| 阶段 | 说明 |
|---|---|
| `request_validating` | 参数和权限校验 |
| `credit_freezing` | 冻结额度 |
| `prompt_enhancing` | Prompt 增强 |
| `pre_moderating` | 生成前审核 |
| `routing_model` | 模型路由 |
| `dispatching` | 任务分发 |
| `model_generating` | 模型生成中 |
| `result_collecting` | 收集模型输出 |
| `asset_persisting` | 媒体资源入库 |
| `postprocess_upscaling` | 图片超分 |
| `postprocess_transcoding` | 视频转码 |
| `postprocess_packaging` | 缩略图、封面、水印处理 |
| `post_moderating` | 生成后审核 |
| `work_persisting` | 作品和版本落库 |
| `credit_committing` | 确认额度消耗 |
| `credit_releasing` | 释放额度 |
| `completed` | 完成 |
| `failing` | 失败收口处理中 |
| `cancelling` | 取消收口处理中 |

说明：

- `current_stage` 不是对外契约中的强稳定字段，但对排障和监控很有价值
- 同一主状态下可以包含多个阶段

## 8. 标准主流程

### 8.1 正常成功流程

```text
created
  -> queued
  -> running
  -> post_processing
  -> reviewing
  -> success
```

### 8.2 对应阶段推进示例

```text
created
  - request_validating
  - credit_freezing
  - prompt_enhancing
  - pre_moderating

queued
  - routing_model
  - dispatching

running
  - model_generating
  - result_collecting

post_processing
  - asset_persisting
  - postprocess_upscaling / postprocess_transcoding / postprocess_packaging

reviewing
  - post_moderating
  - work_persisting
  - credit_committing

success
  - completed
```

## 9. 状态流转规则

### 9.1 合法流转表

| 当前状态 | 可流转到 | 说明 |
|---|---|---|
| `created` | `queued` / `failed` / `cancelled` | 创建后可入队、失败或被取消 |
| `queued` | `running` / `failed` / `cancelled` | 排队后可开始、失败或取消 |
| `running` | `post_processing` / `failed` / `cancelled` | 模型执行完成后进入后处理 |
| `post_processing` | `reviewing` / `failed` / `cancelled` | 后处理完成后进入审核 |
| `reviewing` | `success` / `failed` / `cancelled` | 审核通过后成功，否则失败或取消 |
| `success` | 无 | 终态 |
| `failed` | 无 | 终态 |
| `cancelled` | 无 | 终态 |

### 9.2 非法流转示例

以下流转应被拒绝：

- `queued -> created`
- `success -> running`
- `failed -> queued`
- `cancelled -> post_processing`

系统应返回：

- `TASK_STATUS_INVALID`

并记录审计日志。

## 10. 状态迁移触发事件

### 10.1 `created -> queued`

触发条件：

- 创作请求已落库
- 用户权限校验通过
- 额度冻结成功
- 生成前审核通过
- 编排服务成功生成任务单

若任一前置条件失败：

- 任务进入 `failed`
- 或直接不创建任务，仅创作请求失败

一期建议：

- 只有任务主记录已创建后，才允许进入状态机
- 前置校验失败时也记录 `failed` 任务更利于追踪

### 10.2 `queued -> running`

触发条件：

- 调度器成功取到任务
- 已完成模型路由
- 已成功调用图片或视频生成服务

### 10.3 `running -> post_processing`

触发条件：

- 模型执行返回成功
- 至少有一份有效输出结果
- 输出结果已被系统接收

说明：

- 此时不代表任务已成功
- 只是代表推理阶段完成

### 10.4 `post_processing -> reviewing`

触发条件：

- 后处理执行完成
- 资源已持久化
- 生成了对后续审核可用的媒体资产

### 10.5 `reviewing -> success`

触发条件：

- 生成后审核通过
- 作品与版本已成功落库
- 额度确认扣减成功
- 对用户可见状态已更新

说明：

- `success` 的定义不是“模型成功返回”
- 而是“用户可用结果已经稳定可见”

## 11. 失败处理规则

### 11.1 失败分类

建议至少区分以下失败类型：

- 参数失败
- 权限失败
- 额度失败
- 生成前审核失败
- 模型执行失败
- 回调超时失败
- 后处理失败
- 生成后审核失败
- 落库失败
- 额度提交失败

建议在 `generation_tasks.error_code` 和 `error_message` 中保留摘要信息。

### 11.2 不同阶段失败的处理策略

#### `created` 阶段失败

例如：

- Prompt 增强失败
- 额度冻结失败
- 生成前审核不通过

处理：

- 状态置为 `failed`
- 如果额度已冻结，则释放额度
- 不生成作品

#### `queued` 阶段失败

例如：

- 调度失败
- 路由失败

处理：

- 根据错误类型允许短次数重试
- 超过最大重试次数进入 `failed`

#### `running` 阶段失败

例如：

- 模型调用返回失败
- 模型节点不可用
- 回调异常

处理：

- 可按策略重试
- 若最终失败，则释放额度
- 不生成作品

#### `post_processing` 阶段失败

例如：

- 转码失败
- 资源入库存储失败

处理：

- 优先重试
- 若存在部分中间资源，应标记为不可见
- 失败后释放额度或按策略部分扣减

一期建议：

- 只要未形成用户可用最终结果，就默认释放额度

#### `reviewing` 阶段失败

例如：

- 内容审核拒绝
- 作品落库失败
- 额度确认失败

处理：

- 审核拒绝：任务进入 `failed`，结果不可见，释放额度或按政策处理
- 作品落库失败：优先重试
- 额度确认失败：进入内部补偿流程，不应直接把成功结果暴露给用户

## 12. 重试机制

### 12.1 重试适用场景

建议只对“技术性失败”重试，不对“业务性拒绝”重试。

可重试：

- 网络超时
- 模型服务临时不可用
- 存储写入失败
- 转码节点临时失败

不可重试：

- Prompt 审核拒绝
- 权限不足
- 额度不足
- 非法参数

### 12.2 重试次数建议

一期建议：

- 调度失败：最多 3 次
- 模型调用失败：最多 2 次
- 后处理失败：最多 2 次
- 落库失败：最多 3 次

### 12.3 重试状态规则

重试时不新增主状态，仍保留原状态，但要：

- 增加 `retry_count`
- 写入 `task_status_histories`
- 写入 `task_events`

说明：

- 不建议把“retrying”定义成新的主状态
- 会让状态机复杂化，而收益不大

## 13. 超时机制

### 13.1 超时分类

建议至少配置以下超时：

- 排队超时
- 模型执行超时
- 回调等待超时
- 后处理超时
- 审核超时

### 13.2 超时策略建议

示例建议值：

- 图片任务排队超时：5 分钟
- 视频任务排队超时：15 分钟
- 图片模型执行超时：10 分钟
- 视频模型执行超时：60 分钟
- 后处理超时：15 分钟
- 审核超时：10 分钟

说明：

- 实际值要根据模型供应商 SLA 调整
- 视频任务时长必须和图片任务分开治理

### 13.3 超时后的流转

- 若可重试，则进入重试流程
- 若不可恢复，则进入 `failed`
- 若外部结果晚到，必须通过幂等和终态校验避免错误覆盖

## 14. 取消机制

### 14.1 用户取消

用户取消的前提条件建议如下：

可取消：

- `created`
- `queued`

谨慎取消：

- `running`

不可取消：

- `post_processing`
- `reviewing`
- `success`
- `failed`
- `cancelled`

一期建议：

- 仅支持 `created` 和 `queued` 状态取消
- `running` 状态取消先不对外开放，避免外部模型不支持真正终止导致状态不一致

### 14.2 取消流转规则

```text
created -> cancelled
queued -> cancelled
running -> cancelled   （一期建议仅内部保留）
```

取消后处理：

- 若已冻结额度，释放额度
- 若已入队，撤销调度
- 若已有中间资源，标记废弃

## 15. 回调处理规则

### 15.1 回调基本要求

模型回调和后处理回调必须满足：

- 签名校验
- 来源校验
- 幂等处理
- 原始报文留存
- 严格校验任务当前状态

### 15.2 重复回调处理

如果收到重复回调：

- 若状态和结果一致，直接幂等返回成功
- 若任务已终态，不得覆盖终态
- 若结果冲突，写异常日志并进入人工排查队列

### 15.3 延迟回调处理

例如：

- 任务已经超时失败
- 外部模型又返回成功结果

处理原则：

- 若任务已 `failed` 且已完成补偿，不直接恢复为 `success`
- 记录孤儿结果
- 交由后台工具决定是否人工补挂作品或重放流程

一期建议：

- 不做自动“死而复生”式状态恢复

## 16. 额度联动规则

### 16.1 额度处理时机

建议策略：

1. 任务创建前校验可用额度
2. 进入 `created` 后冻结额度
3. 任务进入 `success` 前确认额度消耗
4. 任务 `failed` 或 `cancelled` 时释放额度

### 16.2 额度处理规则表

| 任务结果 | 额度处理 |
|---|---|
| 创建前失败 | 不冻结 |
| `created` 后失败 | 释放冻结额度 |
| `queued` / `running` 失败 | 释放冻结额度 |
| `post_processing` 失败 | 默认释放冻结额度 |
| 审核拒绝 | 默认释放冻结额度 |
| `success` | 提交正式扣减 |
| `cancelled` | 释放冻结额度 |

说明：

- 这是面向一期用户体验的保守策略
- 后续若有“模型已消耗即计费”的商业规则，可再调整

## 17. 作品落库规则

### 17.1 作品生成时机

建议在以下条件同时满足后才创建用户可见作品：

- 模型生成完成
- 后处理完成
- 生成后审核通过
- 媒体资源已持久化

### 17.2 部分成功处理

例如一次生成 4 张图，只成功 3 张。

一期建议策略二选一，必须统一：

策略 A：

- 只要有最小可用结果，就允许成功
- 作品中记录实际成功资源数

策略 B：

- 要求全部结果成功，否则任务失败

我建议一期采用策略 A，原因如下：

- 更符合 AI 生成任务的不确定性
- 用户体验更好
- 平台资源不会因少量失败全部浪费

实现要求：

- 返回结果中明确 `requestedCount` 和 `successCount`
- 作品版本关联实际成功资源

## 18. 审核联动规则

### 18.1 生成前审核

生成前审核不通过时：

- 任务进入 `failed`
- 不进入调度和模型执行
- 返回明确错误码 `MODERATION_REJECTED`

### 18.2 生成后审核

生成后审核不通过时：

- 任务进入 `failed`
- 作品不对用户可见
- 资源可保留在受控存储区
- 额度按当前策略释放

### 18.3 人工审核

若审核结果为 `manual_review`：

- 主状态保持 `reviewing`
- `current_stage = post_moderating`
- 设置审核超时监控

人工审核通过后：

- `reviewing -> success`

人工审核拒绝后：

- `reviewing -> failed`

## 19. 监控与告警建议

任务状态机必须配套监控，否则状态设计没有实际价值。

建议重点监控：

- 各状态任务数量
- 各阶段平均停留时长
- 终态成功率
- 模型超时率
- 回调重复率
- 后处理失败率
- 审核拒绝率
- 额度冻结未释放异常数

重点告警场景：

- `queued` 长时间堆积
- `running` 超时积压
- `post_processing` 大量失败
- `reviewing` 长时间未结束
- `credit_freezing` 与 `credit_committing` 不平衡

## 20. 一期实现建议

为了控制复杂度，一期建议按以下方式实现：

### 20.1 状态实现方式

- 主状态字段：`status`
- 细阶段字段：`current_stage`
- 历史表：`task_status_histories`
- 事件表：`task_events`

### 20.2 编排实现方式

- 由编排服务作为唯一状态推进控制者
- 模型服务和后处理服务不直接改主状态，只上报事件或结果
- 回调统一进入回调处理器，再由编排服务推进状态

### 20.3 一期不建议做的内容

- 通用可编排流程引擎
- 任意状态回退
- 多层嵌套子任务树
- 自动恢复终态失败任务

这些能力后续可以加，但现在加会明显抬高实现成本。

## 21. 状态流转示例

### 21.1 文生图成功示例

```text
created(request_validating)
-> created(credit_freezing)
-> created(prompt_enhancing)
-> created(pre_moderating)
-> queued(dispatching)
-> running(model_generating)
-> post_processing(asset_persisting)
-> post_processing(postprocess_upscaling)
-> reviewing(post_moderating)
-> reviewing(work_persisting)
-> reviewing(credit_committing)
-> success(completed)
```

### 21.2 视频生成超时失败示例

```text
created
-> queued
-> running(model_generating)
-> running(model_generating retry_count=1)
-> failed(failing)
-> credit_releasing
```

说明：

- `credit_releasing` 建议记录在 `current_stage`
- 主状态最终仍为 `failed`

### 21.3 生成后审核拒绝示例

```text
created
-> queued
-> running
-> post_processing
-> reviewing(post_moderating)
-> failed(failing)
-> credit_releasing
```

## 22. 结论

该平台任务状态机的核心，不是把所有执行细节都做成状态，而是把以下三件事控制住：

- 主状态稳定
- 阶段推进可追踪
- 失败与补偿有明确规则

一期实现时，最关键的工程约束是：

- 编排服务是唯一状态推进中枢
- 所有回调必须幂等
- 成功定义必须以“用户结果可用”为准
- 额度结算必须和终态规则绑定

在本文档之后，最合理的下一步是：

1. 一期 OpenAPI / Swagger 草案
2. 一期 PostgreSQL DDL 草案
3. 编排服务时序图与事件流设计

