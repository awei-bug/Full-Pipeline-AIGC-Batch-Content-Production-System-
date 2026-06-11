# AI内容创作平台核心数据库设计

## 1. 文档目的

本文档基于以下两份上游设计文档，定义 AI 内容创作平台的核心数据库设计方案：

- 《AI内容创作平台整体架构说明》
- 《AI内容创作平台微服务拆分说明》

本文档重点说明：

- 一期核心数据对象与归属
- 数据库分层与存储职责
- 核心表设计建议
- 关键关联关系
- 状态模型设计
- 分库分表与演进建议

本文档定位是架构级数据库设计，不追求直接可执行的完整建表 SQL，而是为后续详细设计、DDL 编写和接口实现提供统一基础。

## 2. 设计目标

数据库设计需要同时满足以下目标：

- 支撑图片和视频生成的主业务闭环
- 支撑异步任务和长流程状态追踪
- 支撑作品、素材和媒体文件管理
- 支撑订阅、积分和额度消耗
- 支撑审核、审计和运营分析
- 保证后续多模型、多租户、开放平台扩展能力

## 3. 数据存储总体设计

平台不应把所有数据都放到单一关系库中。建议采用“关系型数据库 + 缓存 + 消息队列 + 对象存储 + 日志分析存储”的组合。

### 3.1 存储分类

| 存储类型 | 建议技术 | 存储内容 |
|---|---|---|
| 关系型数据库 | PostgreSQL | 用户、任务、作品、订单、审核、配置元数据 |
| 缓存 | Redis | Token、会话、任务短状态、限流、热点缓存 |
| 消息队列 | Kafka / RabbitMQ | 任务事件、回调事件、通知事件 |
| 对象存储 | S3兼容存储 | 图片、视频、封面图、参考图、缩略图 |
| 日志检索存储 | ELK / OpenSearch | 应用日志、审计日志、模型执行日志 |
| 分析数仓（后续） | ClickHouse / BigQuery 类 | 用量分析、成本分析、运营报表 |

### 3.2 一期数据库原则

一期建议：

- 核心业务元数据统一使用 PostgreSQL
- 媒体大文件不入库，只存对象存储地址和元数据
- 长文本提示词允许入库，但要有限长和脱敏策略
- 高频短期状态放 Redis，最终状态落 PostgreSQL
- 所有关键状态变化必须可追踪

## 4. 数据域划分

基于前面的微服务拆分，建议先按数据域进行逻辑分层，即使一期仍使用同一个 PostgreSQL 实例，也要按 schema 或命名空间隔离。

建议数据域如下：

| 数据域 | 对应服务 | 说明 |
|---|---|---|
| auth | 认证服务 | 账号、凭证、登录态映射 |
| user_billing | 用户与订阅服务 | 用户档案、套餐、积分、额度、消费 |
| creation | 内容创作服务 | 创作请求、参数快照 |
| work | 作品服务 | 作品、版本、分享、下载 |
| asset | 素材服务 | 素材元数据、引用关系 |
| prompt | Prompt处理服务 | 模板、风格词、Prompt规则 |
| moderation | 审核策略服务 | 审核记录、策略规则 |
| orchestration | 任务编排服务 | 任务、状态、回调、事件 |
| generation | 推理服务 | 模型执行记录、结果缓存索引 |
| admin | 管理后台服务 | 运营配置、后台操作记录 |

说明：

- 一期可采用单实例多 schema
- 二期逐步分为多数据库
- 三期可按租户、地域、业务量做进一步物理拆分

## 5. 核心实体关系总览

平台的一期核心实体建议围绕以下对象展开：

- 用户
- 套餐 / 权益
- 创作请求
- 任务
- 作品
- 作品版本
- 媒体资源
- 素材
- 审核记录
- 额度流水

核心关系可以概括为：

```text
用户
  -> 创作请求
    -> 编排任务
      -> 推理执行记录
      -> 审核记录
      -> 后处理记录
      -> 作品
        -> 作品版本
          -> 媒体资源

用户
  -> 套餐订阅
  -> 额度账户
    -> 额度流水

用户
  -> 素材
```

## 6. 核心表设计

以下是一期建议优先建设的核心表。字段名称为建议命名，不要求与你后续代码完全一致，但建议保持一致性。

### 6.1 用户与认证域

#### 6.1.1 `users`

用途：存储平台用户主档。

关键字段：

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | bigint / uuid | 用户主键 |
| user_no | varchar(64) | 用户编号，便于外部展示 |
| username | varchar(128) | 用户名 |
| email | varchar(256) | 邮箱 |
| mobile | varchar(32) | 手机号 |
| status | varchar(32) | 状态，active/locked/deleted |
| register_source | varchar(64) | 注册来源 |
| tenant_id | varchar(64) | 租户标识，单租户可先为空 |
| created_at | timestamp | 创建时间 |
| updated_at | timestamp | 更新时间 |

索引建议：

- `uk_users_user_no`
- `uk_users_email`
- `uk_users_mobile`
- `idx_users_tenant_id`

#### 6.1.2 `user_auth_accounts`

用途：存储登录凭证和第三方认证映射。

关键字段：

- `id`
- `user_id`
- `auth_type`，如 password / google / wechat / sso
- `auth_identifier`
- `password_hash`
- `status`
- `last_login_at`
- `created_at`

说明：

- 不建议把登录密码散列直接放在 `users` 主表
- 便于后续扩展多种认证方式

#### 6.1.3 `user_sessions`（可选）

用途：记录登录会话或设备会话。

说明：

- 如果系统以 JWT + Redis 为主，可弱化关系库存储
- 若有审计要求，则应保留

### 6.2 用户订阅与额度域

#### 6.2.1 `subscription_plans`

用途：定义套餐模板。

关键字段：

- `id`
- `plan_code`
- `plan_name`
- `plan_type`
- `monthly_credits`
- `max_concurrent_tasks`
- `image_generation_limit`
- `video_generation_limit`
- `status`
- `created_at`

#### 6.2.2 `user_subscriptions`

用途：记录用户当前与历史套餐关系。

关键字段：

- `id`
- `user_id`
- `plan_id`
- `subscription_status`
- `start_at`
- `end_at`
- `auto_renew_flag`
- `source_order_no`
- `created_at`

索引建议：

- `idx_user_subscriptions_user_id`
- `idx_user_subscriptions_status_end_at`

#### 6.2.3 `credit_accounts`

用途：用户额度账户。

关键字段：

- `id`
- `user_id`
- `available_credits`
- `frozen_credits`
- `total_used_credits`
- `version_no`
- `updated_at`

说明：

- 建议增加 `version_no` 做乐观锁
- 避免高并发扣减时超扣

#### 6.2.4 `credit_transactions`

用途：记录额度流水。

关键字段：

- `id`
- `user_id`
- `account_id`
- `biz_type`，如 image_generate / video_generate / refund
- `biz_no`
- `change_amount`
- `before_amount`
- `after_amount`
- `remark`
- `created_at`

说明：

- `biz_no` 必须和任务或订单关联，保证可追溯
- 金额类或积分类流水不允许直接覆盖，只允许追加记录

### 6.3 创作请求域

#### 6.3.1 `creation_requests`

用途：记录用户一次创作请求的业务主单。

关键字段：

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | bigint / uuid | 主键 |
| request_no | varchar(64) | 创作请求编号 |
| user_id | bigint / uuid | 发起人 |
| request_type | varchar(32) | text_to_image / text_to_video / image_to_image / image_to_video |
| prompt_text | text | 原始提示词 |
| prompt_language | varchar(16) | 原始语言 |
| style_code | varchar(64) | 风格标识 |
| aspect_ratio | varchar(16) | 比例 |
| image_count | int | 图片数量 |
| video_duration_sec | int | 视频时长 |
| status | varchar(32) | created / submitted / processing / completed / failed |
| idempotency_key | varchar(128) | 幂等键 |
| created_at | timestamp | 创建时间 |
| updated_at | timestamp | 更新时间 |

说明：

- `creation_requests` 是业务入口对象
- 一次请求可映射一个或多个任务
- 前端侧优先围绕该对象展示创作历史

索引建议：

- `uk_creation_requests_request_no`
- `idx_creation_requests_user_id_created_at`
- `idx_creation_requests_status`
- `uk_creation_requests_idempotency_key`

#### 6.3.2 `creation_request_params`

用途：存储结构化参数快照。

关键字段：

- `id`
- `request_id`
- `param_json`
- `normalized_param_json`
- `negative_prompt_text`
- `reference_asset_id`
- `seed_value`
- `created_at`

说明：

- 这张表的意义是将变化频繁的生成参数和主表解耦
- 避免主表字段膨胀过快

### 6.4 任务编排域

#### 6.4.1 `generation_tasks`

用途：平台任务主表，是异步编排的核心对象。

关键字段：

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | bigint / uuid | 主键 |
| task_no | varchar(64) | 任务编号 |
| request_id | bigint / uuid | 对应创作请求 |
| user_id | bigint / uuid | 发起用户 |
| task_type | varchar(32) | image_generate / video_generate / postprocess |
| engine_type | varchar(32) | image / video |
| priority | int | 优先级 |
| status | varchar(32) | 任务状态 |
| current_stage | varchar(64) | 当前阶段 |
| model_code | varchar(64) | 路由后的模型标识 |
| provider_code | varchar(64) | 模型供应商 |
| retry_count | int | 重试次数 |
| max_retry_count | int | 最大重试次数 |
| submitted_at | timestamp | 提交时间 |
| started_at | timestamp | 开始时间 |
| finished_at | timestamp | 完成时间 |
| error_code | varchar(64) | 失败码 |
| error_message | varchar(512) | 失败摘要 |
| created_at | timestamp | 创建时间 |
| updated_at | timestamp | 更新时间 |

索引建议：

- `uk_generation_tasks_task_no`
- `idx_generation_tasks_request_id`
- `idx_generation_tasks_user_id_created_at`
- `idx_generation_tasks_status_priority`
- `idx_generation_tasks_model_code`

#### 6.4.2 `task_status_histories`

用途：记录任务状态流转历史。

关键字段：

- `id`
- `task_id`
- `from_status`
- `to_status`
- `stage_name`
- `change_reason`
- `operator_type`，如 system / callback / admin
- `operator_id`
- `created_at`

说明：

- 任务主表只保留当前状态
- 历史轨迹放独立表，便于排障和审计

#### 6.4.3 `task_callbacks`

用途：记录外部模型或内部执行节点的回调。

关键字段：

- `id`
- `task_id`
- `callback_source`
- `callback_status`
- `request_payload`
- `response_payload`
- `received_at`
- `processed_at`

说明：

- 推荐保存原始回调内容
- 后续排障时价值很高

#### 6.4.4 `task_events`

用途：记录任务领域事件，用于事件驱动与调试。

关键字段：

- `id`
- `task_id`
- `event_type`
- `event_payload`
- `published_flag`
- `created_at`

说明：

- 如果后续采用成熟工作流平台，这张表可以弱化
- 一期自建编排时建议保留

### 6.5 推理执行域

#### 6.5.1 `model_execution_records`

用途：记录模型调用与执行明细。

关键字段：

- `id`
- `task_id`
- `execution_no`
- `model_code`
- `provider_code`
- `input_snapshot`
- `request_payload`
- `response_payload`
- `execution_status`
- `started_at`
- `finished_at`
- `latency_ms`
- `estimated_cost`
- `created_at`

说明：

- 该表对成本分析、故障分析、模型对比极其重要
- 不建议只在日志里记录，不入业务库

#### 6.5.2 `postprocess_records`

用途：记录后处理步骤。

关键字段：

- `id`
- `task_id`
- `process_type`，如 upscale / transcode / watermark
- `input_asset_id`
- `output_asset_id`
- `status`
- `started_at`
- `finished_at`
- `error_message`

### 6.6 作品域

#### 6.6.1 `works`

用途：作品主表，面向用户可见的内容对象。

关键字段：

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | bigint / uuid | 主键 |
| work_no | varchar(64) | 作品编号 |
| user_id | bigint / uuid | 所属用户 |
| request_id | bigint / uuid | 来源创作请求 |
| latest_version_id | bigint / uuid | 最新版本 |
| work_type | varchar(32) | image / video |
| title | varchar(256) | 作品标题 |
| status | varchar(32) | draft / ready / blocked / deleted |
| visibility | varchar(32) | private / share / public |
| cover_asset_id | bigint / uuid | 封面资源 |
| created_at | timestamp | 创建时间 |
| updated_at | timestamp | 更新时间 |

索引建议：

- `uk_works_work_no`
- `idx_works_user_id_created_at`
- `idx_works_request_id`

#### 6.6.2 `work_versions`

用途：记录作品版本。

关键字段：

- `id`
- `work_id`
- `version_no`
- `task_id`
- `version_type`，如 original / regenerate / edited
- `prompt_snapshot`
- `status`
- `created_at`

说明：

- 用户反复再生成时，不应覆盖原作品结果
- 必须保留版本链

#### 6.6.3 `media_assets`

用途：媒体资源元数据。

关键字段：

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | bigint / uuid | 主键 |
| asset_no | varchar(64) | 资源编号 |
| asset_type | varchar(32) | image / video / cover / thumbnail / reference |
| storage_provider | varchar(64) | 存储提供方 |
| bucket_name | varchar(128) | 存储桶 |
| object_key | varchar(512) | 对象路径 |
| file_name | varchar(256) | 文件名 |
| mime_type | varchar(128) | MIME类型 |
| file_size | bigint | 文件大小 |
| width | int | 宽度 |
| height | int | 高度 |
| duration_sec | int | 视频时长 |
| checksum | varchar(128) | 校验值 |
| status | varchar(32) | uploaded / ready / archived / deleted |
| created_at | timestamp | 创建时间 |

说明：

- 只存元数据和对象地址
- 不存二进制内容

#### 6.6.4 `work_asset_relations`

用途：作品版本与媒体资源关联表。

关键字段：

- `id`
- `work_version_id`
- `asset_id`
- `relation_type`，如 output / cover / thumbnail / source_reference
- `sort_no`
- `created_at`

说明：

- 一次生成可能产出多张图、多段视频或多种派生资源
- 不建议在版本表上直接塞多个资源字段

#### 6.6.5 `work_shares`

用途：作品分享信息。

关键字段：

- `id`
- `work_id`
- `share_token`
- `share_status`
- `expired_at`
- `created_by`
- `created_at`

### 6.7 素材域

#### 6.7.1 `assets_library`

用途：用户或企业上传的参考素材库。

关键字段：

- `id`
- `asset_id`
- `owner_type`，如 user / tenant
- `owner_id`
- `asset_category`
- `tags_json`
- `review_status`
- `created_at`

说明：

- 该表建立“素材库语义”
- 与 `media_assets` 做一层业务抽象分离

### 6.8 审核域

#### 6.8.1 `moderation_records`

用途：记录输入和输出审核结果。

关键字段：

| 字段 | 类型建议 | 说明 |
|---|---|---|
| id | bigint / uuid | 主键 |
| biz_type | varchar(32) | prompt / image / video / asset |
| biz_id | bigint / uuid | 业务对象ID |
| task_id | bigint / uuid | 关联任务 |
| review_stage | varchar(32) | pre_generate / post_generate |
| result | varchar(32) | pass / reject / manual_review |
| risk_level | varchar(32) | low / medium / high |
| rule_code | varchar(64) | 触发规则 |
| detail_json | jsonb | 审核明细 |
| reviewer_type | varchar(32) | system / manual |
| created_at | timestamp | 创建时间 |

说明：

- 审核表应具备通用性，不要为每个业务对象重复建表

### 6.9 配置与后台域

#### 6.9.1 `prompt_templates`

用途：Prompt 模板配置。

关键字段：

- `id`
- `template_code`
- `template_name`
- `template_type`
- `content`
- `status`
- `created_at`

#### 6.9.2 `style_configs`

用途：风格配置字典。

关键字段：

- `id`
- `style_code`
- `style_name`
- `style_type`
- `config_json`
- `status`

#### 6.9.3 `admin_operation_logs`

用途：后台操作审计。

关键字段：

- `id`
- `operator_id`
- `operation_type`
- `target_type`
- `target_id`
- `operation_detail`
- `ip_address`
- `created_at`

## 7. 关键状态设计

### 7.1 创作请求状态

建议 `creation_requests.status`：

- `created`
- `submitted`
- `processing`
- `completed`
- `failed`
- `cancelled`

说明：

- 前端面向用户展示时优先看创作请求状态
- 任务级细节由任务表承担

### 7.2 任务状态

建议 `generation_tasks.status`：

- `created`
- `queued`
- `running`
- `post_processing`
- `reviewing`
- `success`
- `failed`
- `cancelled`

### 7.3 作品状态

建议 `works.status`：

- `draft`
- `ready`
- `blocked`
- `deleted`

### 7.4 审核结果状态

建议 `moderation_records.result`：

- `pass`
- `reject`
- `manual_review`

## 8. 关键约束与一致性要求

### 8.1 幂等性

以下对象必须具备幂等保障：

- 创作请求提交
- 额度扣减
- 外部模型回调处理
- 任务完成落库

设计建议：

- `creation_requests.idempotency_key` 唯一约束
- 额度流水按 `biz_no + biz_type` 去重
- 回调按外部请求号或事件号去重

### 8.2 事务边界

不建议跨多个服务做分布式强事务。

建议策略：

- 服务内本地事务保证主表一致性
- 服务间通过事件驱动实现最终一致性
- 扣费和任务创建需要清晰定义先后顺序

推荐做法：

1. 先校验额度
2. 冻结或预扣额度
3. 创建创作请求和任务
4. 任务成功后正式消耗
5. 任务失败后释放或退回额度

### 8.3 删除策略

核心业务表不建议物理删除。

建议：

- 用户侧删除作品：业务软删除
- 媒体文件：延迟归档或异步清理
- 审计、任务、流水数据：长期保留

## 9. 索引与性能建议

### 9.1 高频查询场景

重点优化以下查询：

- 用户作品列表
- 用户任务列表
- 任务状态查询
- 后台审核列表
- 用户额度查询

### 9.2 索引原则

- 所有业务编号字段加唯一索引
- 所有按 `user_id + created_at` 查询的主对象加复合索引
- 状态字段和时间字段组合索引用于后台筛选
- 大文本字段不参与普通 B-Tree 索引

### 9.3 分页建议

用户作品列表和任务列表建议优先使用：

- 游标分页
- 或基于 `created_at + id` 的稳定翻页

不建议在大表上长期使用深分页 `offset`

## 10. 分库分表演进建议

### 10.1 一期

- 单 PostgreSQL 实例
- 多 schema 隔离
- 不做分表

适用前提：

- 用户量和任务量还处于初期
- 团队更关注产品闭环速度

### 10.2 二期

- 按服务域逐步拆库
- `generation_tasks`、`task_status_histories`、`model_execution_records` 可优先独立
- 审核和日志数据逐步从主业务库旁路

### 10.3 三期

- 按租户、区域或时间维度分片
- 历史任务和操作日志归档
- 分析类数据沉淀到数仓或分析库

## 11. 安全与合规建议

### 11.1 敏感字段保护

建议对以下字段做脱敏或加密：

- 邮箱
- 手机号
- IP地址
- 登录标识
- 部分 Prompt 文本

### 11.2 Prompt存储建议

Prompt 文本建议保留，但要注意：

- 长度限制
- 敏感词脱敏
- 避免原样落库存储密钥、口令等敏感数据

### 11.3 审计要求

以下行为建议强制留痕：

- 用户登录
- 套餐变更
- 额度扣减和退款
- 模型调用失败
- 后台人工审核
- 后台配置变更

## 12. 一期最小可落地表集

如果以 MVP 目标优先，建议先落以下核心表：

1. `users`
2. `user_auth_accounts`
3. `subscription_plans`
4. `user_subscriptions`
5. `credit_accounts`
6. `credit_transactions`
7. `creation_requests`
8. `creation_request_params`
9. `generation_tasks`
10. `task_status_histories`
11. `model_execution_records`
12. `postprocess_records`
13. `works`
14. `work_versions`
15. `media_assets`
16. `work_asset_relations`
17. `moderation_records`
18. `prompt_templates`
19. `style_configs`
20. `admin_operation_logs`

这套表已经足以支撑：

- 文生图
- 文生视频
- 用户作品管理
- 任务编排追踪
- 额度消耗
- 基础审核

## 13. 结论

该平台的数据库设计核心，不是“表尽可能细”，而是“业务对象清晰、状态可追踪、服务边界可演进”。

一期应优先保证以下几点：

- 创作请求、任务、作品三层对象分离
- 媒体文件与业务元数据分离
- 额度流水、任务历史、审核记录可追溯
- 模型执行记录可支撑排障和成本分析

按当前设计继续往下推进，最合理的下一步是：

1. 核心接口设计文档
2. 任务状态机设计文档
3. 一期数据库DDL草案

