# data-hub · 商品知识数据中心

统一工作台可使用 PostgreSQL 存储商品知识，运行 Python 需要先安装本目录 `requirements.txt`。`HUB_DATABASE_URL` 指向目标 PostgreSQL；未配置时仍使用原 SQLite 过渡库。切换前在服务停止写入后运行 `migrate_sqlite_to_postgres.py --source <SQLite路径>`，目标商品和同步日志表必须为空，脚本会逐行核对并拒绝覆盖。迁移前备份并保留源文件，完成实际链路验证后再处理旧库。不要把数据库连接字符串写入日志或提交到仓库。

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
| `HUB_TOKENS` | 空 | `slug1:token1,slug2:token2`；留空时所有受保护端点一律 401（fail-closed）。令牌必须与 `X-Hub-Tenant` 指定的租户一致 |

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

`/hub/ingest` 的商品项可设置 `preserve_generated_copy: true`。对于已有商品，此标记保留原有的 `title_en`、`desc_en` 和 `declare_name_en`，即使请求中包含这三个字段也以已有值为准；其他字段仍按正常写入规则更新。新商品没有旧值可保留。不设置该标记时，沿用原来的完整替换行为，缺失字段不会自动保留。内容平台在当前任务没有生成文案时使用此标记，避免图片或视频任务清空已有文案。
