# 内容生成 × 电商系统：数据中心整合方案

两个项目不合并代码、不合并数据库，通过一层**商品知识数据中心（data-hub）**形成单一体系。

```
content_create（内容生产）  →  data-hub（唯一事实来源）  →  Flask 电商（上架 + AI 客服）
```

## 一、为什么是数据中心而不是直连

原先 content_create 打包 zip 直推商城，是一次性文件传输。它有三个硬伤：

| 问题 | 后果 |
| --- | --- |
| 无稳定主键 | 同一商品重复推送会变成多件商品 |
| 无版本 | 内容改了商城不知道，只能重新全量推 |
| 无回执 | 内容侧不知道有没有上架成功 |

更关键的是第三条链路：AI 客服拿不到内容侧产出的卖点、场景、参数、FAQ，只能基于品名和价格做正则校验。客服的准确性上限被知识供给卡死，换更强的模型也救不回来。

数据中心解决的就是这三件事：**身份（幂等）+ 版本（增量）+ 知识（客服可用）**。

## 二、数据模型

表 `hub_products`，唯一键 `(tenant_slug, external_id)`。

- **身份**：`external_id` 内容平台侧取 `cc-{productId}`，重推即更新
- **版本**：`content_hash` 变化才 `version + 1`，未变化返回 `unchanged`
- **状态机**：`draft`（待补价/待确认）→ `approved`（内容就绪）→ `published`（已上架）→ `archived`
- **知识字段**：`selling_points` / `scenario` / `spec` / `faq` / `desc_zh` / `desc_en` / `images` / 跨境字段
- **回执**：`published_product_id` 由电商侧上架后回写

电商库新增 `t_product_knowledge` 作为本地副本，客服检索走本地，数据中心只作为回源。

## 三、数据流

### 1. 生成即入库（内容平台）

```
POST /api/data-hub/jobs/:jobId/ingest
```

直接读任务产出写入数据中心，不要求图片已就绪。适合挂在任务完成回调上。

### 2. 成品包入库（内容平台）

```
POST /api/data-hub/jobs/:jobId/sync
```

走成品包口径，只有含图片的条目才会入库。

### 3. 拉取上架（电商侧）

```
POST /products/hub/sync/     body: {status?, since?, limit?, publish?, ack?}
```

- 缺售价的记录**只登记知识不建商品**，避免发明价格
- `publish=false` 时按草稿态导入，人工确认后再上架
- 成功后回执 `published_product_id`，数据中心状态转 `published`

命令行等价：

```bash
python scripts/sync_from_hub.py --slug demo            # 上架
python scripts/sync_from_hub.py --slug demo --draft    # 草稿
python scripts/sync_from_hub.py --since 2026-09-01T00:00:00+00:00   # 增量
```

### 4. 客服消费（电商侧）

`agents/knowledge.py` 提供知识卡：本地副本命中优先，未命中回源数据中心。

`CustomerServiceAgent` 把知识卡压成 `knowledge_facts` 注入 prompt，并明确约束：只能引用其中事实，没有的参数回答"这个我需要帮你确认"。

## 四、启动

推荐使用根目录统一入口，一次按完整链路启动：

```powershell
.\dev.ps1 full
.\dev.ps1 status
.\dev.ps1 stop
```

日常只开发内容平台时：

```powershell
.\dev.ps1 content
```

兼容手动启动 data-hub：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-data-hub.ps1
powershell -ExecutionPolicy Bypass -File scripts/stop-data-hub.ps1
```

内容平台 API 与电商侧需要同一组环境变量：

| 变量 | 示例 | 说明 |
| --- | --- | --- |
| `DATA_HUB_URL` | `http://127.0.0.1:8120` | 数据中心地址 |
| `DATA_HUB_TOKEN` | `hub-local-token` | 与 HUB_TOKENS 中该租户的值一致 |
| `DATA_HUB_TENANT_SLUG` | `demo` | 租户标识 |

服务端另有 `HUB_PORT`（默认 8120）与 `HUB_TOKENS`（格式 `slug1:token1,slug2:token2`，留空则免鉴权，仅限本机开发）。

## 五、API 契约

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/hub/ingest` | 批量写入，幂等 |
| GET | `/hub/products?tenant=&status=&since=&q=&limit=` | 拉取 / 增量同步 |
| GET | `/hub/products/{tenant}/{external_id}` | 单条查询 |
| POST | `/hub/products/{tenant}/{external_id}/ack` | 上架回执 |
| POST | `/hub/products/{tenant}/{external_id}/status` | 状态流转 |
| POST | `/hub/search` | 客服知识检索，返回知识卡与数值白名单 |
| GET | `/hub/stats?tenant=` | 概览 |

鉴权：`X-Hub-Token` + `X-Hub-Tenant`（或 `Authorization: Bearer`）。

## 六、AI 客服的准确性做了什么

四道防线，按执行顺序：

1. **知识注入**：`knowledge_facts` 把卖点/参数/FAQ 直接给模型，覆盖"模型没见过就编"的根源
2. **思维链拦截**：部分模型会把推理过程当正文返回，命中即丢弃并回退规则回复
3. **参数校验**：回复中的数字+单位（续航 36 小时、2000mAh 等）必须在知识卡里能找到，找不到判定编造
4. **价格校验**：`¥xx` 必须命中商品库或知识卡价格集，命中不了回退安全模板

另外修了检索排序：关键词命中时按**相关度**（品名 > 简介）排序，此前按热销排序导致新上架商品永远沉底，问"榨汁杯"会返回咖啡和 T 恤。

## 七、验证

```bash
# 电商项目目录，用其 .venv
python scripts/verify_hub_integration.py --slug demo
```

覆盖 20 项断言：连通性 → 写入 → 同步上架 → 字段落库 → 知识缓存 → 客服检索 → 编排应答 → 幂等复同步。

## 八、已知边界

- 图片默认直接用内容平台 URL，未落本地 static。跨域/换机器部署需开 `DATA_HUB_FETCH_IMAGES` 或改用对象存储
- 检索是关键词打分，未上向量。商品量过万后需要接嵌入检索
- `t_product_knowledge` 是副本，数据中心删记录不会自动删本地副本，靠 `external_id` 对齐
- 内容平台任务完成回调会自动触发生成内容入库；若数据中心暂时不可用，回调仍会成功落库，响应中的 `dataHubSync.status=failed` 可用于告警或手动重试
