# data-hub · 商品知识数据中心

内容平台与电商系统之间的唯一事实来源。零第三方依赖，Python 标准库 `http.server` + `sqlite3`。

## 启动

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-data-hub.ps1
```

或手动：

```bash
set HUB_PORT=8120
set HUB_TOKENS=demo:hub-local-token
python apps/data-hub/app.py
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HUB_HOST` | `127.0.0.1` | 监听地址 |
| `HUB_PORT` | `8120` | 端口 |
| `HUB_DB_PATH` | `apps/data-hub/data-hub.db` | SQLite 路径 |
| `HUB_TOKENS` | 空 | `slug1:token1,slug2:token2`；留空免鉴权，仅限本机 |

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/hub/ingest` | 批量写入，按 `(tenant, external_id)` 幂等 |
| GET | `/hub/products` | 拉取，`since` 支持增量 |
| GET | `/hub/products/{tenant}/{external_id}` | 单条 |
| POST | `/hub/products/{tenant}/{external_id}/ack` | 上架回执 |
| POST | `/hub/products/{tenant}/{external_id}/status` | 状态流转 |
| POST | `/hub/search` | 客服知识检索 |
| GET | `/hub/stats` | 概览 |

鉴权头：`X-Hub-Token`、`X-Hub-Tenant`。

## 幂等与版本

写入时计算内容哈希：

- 新记录 → `created`，`version = 1`，状态 `draft`
- 哈希相同 → `unchanged`，不动版本
- 哈希变化 → `updated`，`version + 1`；已发布的记录保持 `published` 以便电商侧更新而非新建

## 写入字段

```
external_id   title   subtitle   title_en
price   currency   stock   category   brand
tags[]  selling_points[]  scenario  spec{}  faq[{q,a}]
desc_zh  desc_en  images[]  video_url
declare_name_cn  declare_name_en  declare_value  goods_type  hs_code  logistics_note
```

`tags` / `selling_points` 支持字符串自动切分，`faq` 支持 dict 或数组。
