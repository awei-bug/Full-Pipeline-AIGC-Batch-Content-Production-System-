# AI内容创作平台核心接口设计

## 1. 文档目的

本文档基于以下设计文档，定义 AI 内容创作平台的一期核心接口方案：

- 《AI内容创作平台整体架构说明》
- 《AI内容创作平台微服务拆分说明》
- 《AI内容创作平台核心数据库设计》

本文档重点说明：

- 对前端开放的核心业务接口
- 服务之间的内部接口
- 异步任务回调接口
- 接口报文规范
- 状态查询与错误码设计
- 一期接口落地建议

本文档以架构和详细设计之间的“接口级设计”为目标，优先保证可实施性和一致性，不追求覆盖所有未来扩展场景。

## 2. 接口设计原则

平台接口建议遵循以下原则：

- 前后端接口按业务对象设计，不直接暴露底层模型概念
- 图片与视频创作入口统一，但允许按能力拆分独立接口
- 长耗时操作必须异步化
- 所有写接口必须具备幂等设计
- 对外接口稳定，对内接口可演进
- 错误码、状态码、响应结构统一
- 上传文件走对象存储或预签名上传，不走大文件直传业务服务

## 3. 接口分层

平台接口建议分为四类：

| 接口类型 | 调用方 | 说明 |
|---|---|---|
| 外部业务接口 | Web / App / H5 / 第三方 | 面向用户与外部系统 |
| 内部服务接口 | 平台微服务之间 | 服务间同步调用 |
| 异步事件与回调接口 | 模型供应方 / 任务执行节点 | 异步状态回传 |
| 后台管理接口 | 管理后台 | 运营、审核、配置 |

## 4. 通用规范

### 4.1 协议建议

- 协议：HTTPS
- 风格：RESTful 为主
- 数据格式：JSON
- 文件上传：对象存储预签名 URL 或分片上传
- 字符编码：UTF-8

### 4.2 统一路径规范

建议采用如下路径前缀：

- 外部接口：`/api/v1/...`
- 内部接口：`/internal/v1/...`
- 回调接口：`/callback/v1/...`
- 后台接口：`/admin-api/v1/...`

### 4.3 通用请求头

建议所有外部接口支持以下请求头：

| Header | 是否必须 | 说明 |
|---|---|---|
| Authorization | 是 | Bearer Token |
| X-Request-Id | 否 | 请求链路追踪ID |
| X-Idempotency-Key | 写接口建议 | 幂等键 |
| X-Client-Type | 否 | web / app / admin |
| X-Tenant-Id | 多租户时建议 | 租户标识 |

### 4.4 统一响应结构

建议统一响应结构如下：

```json
{
  "code": "SUCCESS",
  "message": "ok",
  "requestId": "req_20260609_001",
  "data": {}
}
```

字段说明：

- `code`：平台错误码或成功码
- `message`：可读描述
- `requestId`：链路追踪编号
- `data`：业务返回体

### 4.5 分页返回结构

```json
{
  "code": "SUCCESS",
  "message": "ok",
  "requestId": "req_xxx",
  "data": {
    "items": [],
    "nextCursor": "cursor_xxx",
    "hasMore": true
  }
}
```

说明：

- 优先使用游标分页
- 避免深分页造成性能问题

## 5. 外部业务接口设计

### 5.1 用户登录

#### 5.1.1 密码登录

- 方法：`POST`
- 路径：`/api/v1/auth/login`

请求示例：

```json
{
  "loginType": "password",
  "identifier": "user@example.com",
  "password": "******"
}
```

响应示例：

```json
{
  "code": "SUCCESS",
  "message": "ok",
  "requestId": "req_001",
  "data": {
    "accessToken": "token_xxx",
    "refreshToken": "refresh_xxx",
    "expiresIn": 7200,
    "user": {
      "userId": "u_1001",
      "username": "demo_user"
    }
  }
}
```

### 5.2 获取当前用户信息

- 方法：`GET`
- 路径：`/api/v1/users/me`

返回字段建议：

- 用户基础信息
- 当前套餐
- 可用积分或额度
- 并发任务上限

### 5.3 创建图片生成任务

#### 5.3.1 文生图

- 方法：`POST`
- 路径：`/api/v1/creations/images`

请求示例：

```json
{
  "prompt": "一只未来感十足的机械猫，电影级灯光，超高细节",
  "styleCode": "cinematic",
  "aspectRatio": "16:9",
  "imageCount": 4,
  "qualityLevel": "high",
  "negativePrompt": "low quality, blurry",
  "seed": 123456
}
```

响应示例：

```json
{
  "code": "SUCCESS",
  "message": "task created",
  "requestId": "req_002",
  "data": {
    "creationRequestId": "cr_1001",
    "taskIds": ["gt_2001"],
    "status": "submitted"
  }
}
```

说明：

- 前端面向业务对象优先记录 `creationRequestId`
- 如果一次请求拆出多个任务，也允许返回多个 `taskIds`

#### 5.3.2 图生图

- 方法：`POST`
- 路径：`/api/v1/creations/images/by-reference`

请求示例：

```json
{
  "prompt": "转成赛博朋克风格",
  "referenceAssetId": "asset_3001",
  "styleCode": "cyberpunk",
  "strength": 0.75,
  "imageCount": 2
}
```

### 5.4 创建视频生成任务

#### 5.4.1 文生视频

- 方法：`POST`
- 路径：`/api/v1/creations/videos`

请求示例：

```json
{
  "prompt": "雨夜东京街头，镜头缓慢推进，霓虹灯反射在地面",
  "styleCode": "realistic",
  "aspectRatio": "16:9",
  "durationSec": 8,
  "resolution": "720p",
  "cameraMotion": "slow_push"
}
```

响应示例：

```json
{
  "code": "SUCCESS",
  "message": "task created",
  "requestId": "req_003",
  "data": {
    "creationRequestId": "cr_1002",
    "taskIds": ["gt_2002"],
    "status": "submitted"
  }
}
```

#### 5.4.2 图生视频

- 方法：`POST`
- 路径：`/api/v1/creations/videos/by-reference`

请求示例：

```json
{
  "prompt": "让角色向前走并微笑",
  "referenceAssetId": "asset_3002",
  "durationSec": 5,
  "resolution": "720p"
}
```

### 5.5 查询创作请求详情

- 方法：`GET`
- 路径：`/api/v1/creations/{creationRequestId}`

响应建议包含：

- 创作请求基本信息
- 当前状态
- 关联任务列表
- 若已完成，返回关联作品信息

### 5.6 查询任务状态

- 方法：`GET`
- 路径：`/api/v1/tasks/{taskId}`

响应示例：

```json
{
  "code": "SUCCESS",
  "message": "ok",
  "requestId": "req_004",
  "data": {
    "taskId": "gt_2002",
    "taskType": "video_generate",
    "status": "running",
    "currentStage": "model_generating",
    "progress": 60,
    "errorCode": null,
    "errorMessage": null
  }
}
```

说明：

- `progress` 为可选近似值
- 不要求底层所有模型都能精确给出进度

### 5.7 查询我的任务列表

- 方法：`GET`
- 路径：`/api/v1/tasks`

查询参数建议：

- `status`
- `taskType`
- `cursor`
- `pageSize`

### 5.8 查询我的作品列表

- 方法：`GET`
- 路径：`/api/v1/works`

查询参数建议：

- `workType`
- `status`
- `cursor`
- `pageSize`

### 5.9 查询作品详情

- 方法：`GET`
- 路径：`/api/v1/works/{workId}`

响应建议包含：

- 作品主信息
- 最新版本
- 版本列表
- 资源列表
- 分享状态

### 5.10 删除作品

- 方法：`DELETE`
- 路径：`/api/v1/works/{workId}`

说明：

- 对用户侧应做软删除
- 不建议立刻物理删除媒体文件

### 5.11 再生成作品

- 方法：`POST`
- 路径：`/api/v1/works/{workId}/regenerate`

请求示例：

```json
{
  "promptOverride": "色调更温暖，光影更明显",
  "keepStyle": true
}
```

说明：

- 再生成本质上仍应创建新的 `creationRequest`
- 不应直接覆盖历史版本

### 5.12 获取上传凭证

- 方法：`POST`
- 路径：`/api/v1/assets/upload-credentials`

请求示例：

```json
{
  "fileName": "reference.png",
  "contentType": "image/png",
  "fileSize": 2048000,
  "assetType": "reference"
}
```

响应示例：

```json
{
  "code": "SUCCESS",
  "message": "ok",
  "requestId": "req_005",
  "data": {
    "assetId": "asset_3003",
    "uploadUrl": "https://storage.example.com/xxx",
    "method": "PUT",
    "headers": {
      "Content-Type": "image/png"
    }
  }
}
```

### 5.13 确认素材上传完成

- 方法：`POST`
- 路径：`/api/v1/assets/{assetId}/complete`

请求示例：

```json
{
  "checksum": "sha256_xxx",
  "width": 1024,
  "height": 1024
}
```

### 5.14 获取分享链接

- 方法：`POST`
- 路径：`/api/v1/works/{workId}/share`

响应建议：

- `shareUrl`
- `shareToken`
- `expiredAt`

## 6. 后台管理接口设计

### 6.1 后台任务列表

- 方法：`GET`
- 路径：`/admin-api/v1/tasks`

查询参数建议：

- `status`
- `taskType`
- `providerCode`
- `modelCode`
- `userId`
- `createdAtFrom`
- `createdAtTo`

### 6.2 后台审核列表

- 方法：`GET`
- 路径：`/admin-api/v1/moderations`

### 6.3 人工审核处理

- 方法：`POST`
- 路径：`/admin-api/v1/moderations/{moderationId}/review`

请求示例：

```json
{
  "action": "approve",
  "reason": "manual verified"
}
```

### 6.4 模板配置

- `GET /admin-api/v1/prompt-templates`
- `POST /admin-api/v1/prompt-templates`
- `PUT /admin-api/v1/prompt-templates/{templateId}`

### 6.5 风格配置

- `GET /admin-api/v1/style-configs`
- `POST /admin-api/v1/style-configs`
- `PUT /admin-api/v1/style-configs/{styleId}`

### 6.6 用户额度调整

- 方法：`POST`
- 路径：`/admin-api/v1/users/{userId}/credits/adjust`

请求示例：

```json
{
  "changeAmount": 100,
  "reason": "operation compensation"
}
```

## 7. 内部服务接口设计

内部接口主要用于微服务之间同步协作。建议只在内网暴露，并通过服务鉴权控制访问。

### 7.1 用户与订阅服务接口

#### 7.1.1 查询用户创作权限

- 方法：`POST`
- 路径：`/internal/v1/users/validate-creation`

请求示例：

```json
{
  "userId": "u_1001",
  "requestType": "text_to_video"
}
```

响应字段建议：

- 是否允许创作
- 当前套餐
- 可用额度
- 并发限制
- 拒绝原因

#### 7.1.2 冻结额度

- 方法：`POST`
- 路径：`/internal/v1/credits/freeze`

请求示例：

```json
{
  "userId": "u_1001",
  "bizType": "video_generate",
  "bizNo": "cr_1002",
  "amount": 40
}
```

#### 7.1.3 确认消耗额度

- 方法：`POST`
- 路径：`/internal/v1/credits/commit`

#### 7.1.4 释放额度

- 方法：`POST`
- 路径：`/internal/v1/credits/release`

### 7.2 Prompt处理服务接口

#### 7.2.1 Prompt增强

- 方法：`POST`
- 路径：`/internal/v1/prompts/enhance`

请求示例：

```json
{
  "requestType": "text_to_image",
  "prompt": "一只机械猫",
  "styleCode": "cinematic",
  "aspectRatio": "16:9"
}
```

响应字段建议：

- 原始 Prompt
- 增强后 Prompt
- 负面 Prompt
- 结构化参数

### 7.3 审核策略服务接口

#### 7.3.1 生成前审核

- 方法：`POST`
- 路径：`/internal/v1/moderations/pre-check`

请求体建议包含：

- `bizType`
- `bizId`
- `userId`
- `prompt`
- `requestType`
- `referenceAssetIds`

#### 7.3.2 生成后审核

- 方法：`POST`
- 路径：`/internal/v1/moderations/post-check`

请求体建议包含：

- `bizType`
- `bizId`
- `taskId`
- `assetIds`

### 7.4 任务编排服务接口

#### 7.4.1 提交任务

- 方法：`POST`
- 路径：`/internal/v1/tasks/submit`

请求示例：

```json
{
  "creationRequestId": "cr_1002",
  "userId": "u_1001",
  "taskType": "video_generate",
  "engineType": "video",
  "priority": 5,
  "normalizedParams": {
    "durationSec": 8,
    "resolution": "720p"
  }
}
```

响应建议：

- `taskId`
- `status`

#### 7.4.2 查询任务详情

- 方法：`GET`
- 路径：`/internal/v1/tasks/{taskId}`

#### 7.4.3 更新任务状态

- 方法：`POST`
- 路径：`/internal/v1/tasks/{taskId}/status`

说明：

- 该接口主要供内部执行节点或回调处理器调用
- 不应直接暴露给前端

### 7.5 模型路由服务接口

#### 7.5.1 获取模型路由结果

- 方法：`POST`
- 路径：`/internal/v1/model-routing/resolve`

请求字段建议：

- `taskType`
- `requestType`
- `userPlan`
- `resolution`
- `durationSec`

响应字段建议：

- `providerCode`
- `modelCode`
- `routeReason`

### 7.6 图片生成服务接口

#### 7.6.1 执行图片生成

- 方法：`POST`
- 路径：`/internal/v1/image-generation/jobs`

请求字段建议：

- `taskId`
- `providerCode`
- `modelCode`
- `prompt`
- `negativePrompt`
- `imageCount`
- `referenceAssets`
- `params`
- `callbackUrl`

### 7.7 视频生成服务接口

#### 7.7.1 执行视频生成

- 方法：`POST`
- 路径：`/internal/v1/video-generation/jobs`

请求字段建议：

- `taskId`
- `providerCode`
- `modelCode`
- `prompt`
- `referenceAssets`
- `durationSec`
- `resolution`
- `params`
- `callbackUrl`

### 7.8 后处理服务接口

#### 7.8.1 提交后处理任务

- 方法：`POST`
- 路径：`/internal/v1/postprocess/jobs`

请求字段建议：

- `taskId`
- `assetIds`
- `jobTypes`
- `outputProfile`

## 8. 异步回调接口设计

异步回调接口是整个平台稳定性的关键点，必须优先标准化。

### 8.1 模型执行回调

- 方法：`POST`
- 路径：`/callback/v1/model-executions/result`

请求示例：

```json
{
  "providerCode": "provider_a",
  "externalJobId": "job_xxx",
  "taskId": "gt_2002",
  "status": "success",
  "progress": 100,
  "outputs": [
    {
      "assetType": "video",
      "downloadUrl": "https://example.com/file.mp4",
      "width": 1280,
      "height": 720,
      "durationSec": 8
    }
  ],
  "errorCode": null,
  "errorMessage": null,
  "callbackAt": "2026-06-09T18:00:00Z"
}
```

设计要求：

- 必须支持重复回调幂等处理
- 必须校验签名或来源
- 建议保留原始回调体

### 8.2 后处理回调

- 方法：`POST`
- 路径：`/callback/v1/postprocess/result`

### 8.3 审核回调

- 方法：`POST`
- 路径：`/callback/v1/moderation/result`

说明：

- 如果审核服务本身是同步返回，可不需要该接口
- 若接入第三方异步审核，应保留

## 9. WebSocket / SSE 推送设计

对于长任务，不建议只依赖前端轮询。建议支持 WebSocket 或 SSE 推送。

### 9.1 推送主题建议

- `task.status.changed`
- `creation.completed`
- `moderation.rejected`
- `credit.changed`

### 9.2 推送报文示例

```json
{
  "eventType": "task.status.changed",
  "taskId": "gt_2002",
  "creationRequestId": "cr_1002",
  "status": "post_processing",
  "progress": 85,
  "occurredAt": "2026-06-09T18:10:00Z"
}
```

## 10. 错误码设计建议

建议采用“业务域 + 编号”的方式定义错误码。

### 10.1 通用错误码

| 错误码 | 说明 |
|---|---|
| SUCCESS | 成功 |
| INVALID_PARAM | 参数错误 |
| UNAUTHORIZED | 未登录或Token失效 |
| FORBIDDEN | 无权限 |
| NOT_FOUND | 资源不存在 |
| TOO_MANY_REQUESTS | 请求过于频繁 |
| INTERNAL_ERROR | 系统内部错误 |

### 10.2 创作域错误码

| 错误码 | 说明 |
|---|---|
| CREATION_PROMPT_INVALID | Prompt不合法 |
| CREATION_NOT_ALLOWED | 当前用户不允许发起创作 |
| CREATION_IDEMPOTENT_CONFLICT | 幂等键冲突 |
| CREATION_REQUEST_NOT_FOUND | 创作请求不存在 |

### 10.3 额度与订阅域错误码

| 错误码 | 说明 |
|---|---|
| CREDIT_INSUFFICIENT | 可用额度不足 |
| CREDIT_FREEZE_FAILED | 额度冻结失败 |
| SUBSCRIPTION_EXPIRED | 套餐已过期 |
| CONCURRENCY_LIMIT_EXCEEDED | 并发任务超限 |

### 10.4 任务域错误码

| 错误码 | 说明 |
|---|---|
| TASK_NOT_FOUND | 任务不存在 |
| TASK_STATUS_INVALID | 当前任务状态不允许该操作 |
| TASK_CALLBACK_DUPLICATED | 回调重复 |
| TASK_EXECUTION_TIMEOUT | 任务执行超时 |

### 10.5 审核域错误码

| 错误码 | 说明 |
|---|---|
| MODERATION_REJECTED | 内容审核不通过 |
| MODERATION_PENDING | 内容待人工审核 |

## 11. 幂等与安全要求

### 11.1 幂等要求

以下接口建议强制支持幂等：

- 创建图片任务
- 创建视频任务
- 获取上传凭证
- 冻结额度
- 外部模型回调

建议方式：

- 前端创建任务时传 `X-Idempotency-Key`
- 服务端落库唯一约束
- 回调按 `providerCode + externalJobId + status` 去重

### 11.2 安全要求

- 所有外部接口必须鉴权
- 内部接口必须走服务间鉴权或 mTLS
- 上传地址要短时有效
- 分享链接应支持失效时间和撤销
- 回调接口必须做签名验证、时间戳校验、IP白名单或令牌校验

## 12. 一期接口最小集合

如果只围绕 MVP 上线，一期建议最少实现以下接口：

### 12.1 外部接口

1. `POST /api/v1/auth/login`
2. `GET /api/v1/users/me`
3. `POST /api/v1/creations/images`
4. `POST /api/v1/creations/videos`
5. `GET /api/v1/creations/{creationRequestId}`
6. `GET /api/v1/tasks/{taskId}`
7. `GET /api/v1/works`
8. `GET /api/v1/works/{workId}`
9. `POST /api/v1/assets/upload-credentials`
10. `POST /api/v1/assets/{assetId}/complete`

### 12.2 内部接口

1. `POST /internal/v1/users/validate-creation`
2. `POST /internal/v1/credits/freeze`
3. `POST /internal/v1/credits/commit`
4. `POST /internal/v1/credits/release`
5. `POST /internal/v1/prompts/enhance`
6. `POST /internal/v1/moderations/pre-check`
7. `POST /internal/v1/tasks/submit`
8. `POST /internal/v1/image-generation/jobs`
9. `POST /internal/v1/video-generation/jobs`
10. `POST /internal/v1/postprocess/jobs`

### 12.3 回调接口

1. `POST /callback/v1/model-executions/result`
2. `POST /callback/v1/postprocess/result`

## 13. 推荐后续工作

在本文档之后，建议立刻补齐两类设计：

1. 任务状态机设计文档
2. 一期 OpenAPI / Swagger 草案

原因很直接：

- 当前已经明确了服务边界、数据模型和接口对象
- 现在最需要把任务流转规则和字段级 API 契约定死

## 14. 结论

该平台接口设计的关键不是“接口数量”，而是三件事：

- 创作请求、任务、作品三个对象的职责分离
- 长任务异步化与状态可查询
- 外部稳定接口与内部可演进接口分层

按当前文档体系继续推进，最合理的下一步是：

1. 任务状态机设计文档
2. OpenAPI草案
3. 一期核心DDL草案

