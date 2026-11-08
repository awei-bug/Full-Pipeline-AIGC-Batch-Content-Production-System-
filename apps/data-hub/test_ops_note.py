"""ops_note 独立字段回归。

核心契约：运营提示不得进入顾客可见的 desc_zh，且提示变化要推进 version，
让下游增量同步能感知。数据中心的 ingest 是整条覆盖语义，因此调用方必须
先读后写；这里验证的是字段本身的分层与版本行为。
"""
import importlib.util
import sqlite3
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).with_name("app.py")


def load_module():
    spec = importlib.util.spec_from_file_location("data_hub_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def hub(tmp_path):
    module = load_module()
    module.HUB_DATABASE_URL = ""
    module.DB_PATH = str(tmp_path / "hub.db")
    conn = sqlite3.connect(module.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(module.SCHEMA)
    conn.commit()
    yield module, conn
    conn.close()


def columns(conn):
    return {row[1] for row in conn.execute("PRAGMA table_info(hub_products)")}


def base_item(**overrides):
    item = {
        "external_id": "yg-1-1",
        "title": "演示商品",
        "price": 129.0,
        "stock": 3,
        "desc_zh": "便携式榨汁杯，380ml 容量。",
        "ops_note": "【运营提示】仅剩 3 件",
    }
    item.update(overrides)
    return item


def test_new_schema_has_ops_note_column(hub):
    _, conn = hub
    assert "ops_note" in columns(conn)


def test_migrate_schema_adds_column_to_existing_database(hub):
    module, conn = hub
    # 模拟早期版本的表：重建一张不含 ops_note 的表。
    legacy_schema = module.SCHEMA.replace("  ops_note TEXT,\n", "")
    conn.executescript("DROP TABLE hub_products;")
    conn.executescript(legacy_schema)
    conn.commit()
    assert "ops_note" not in columns(conn)

    module.migrate_schema(conn)
    conn.commit()
    assert "ops_note" in columns(conn)
    # 重复执行必须幂等，不能因为列已存在而报错。
    module.migrate_schema(conn)
    conn.commit()


def test_ops_note_is_stored_separately_from_customer_description(hub):
    module, conn = hub
    result = module.upsert_item(conn, "demo", base_item(), "shop_publish", "job-1")
    conn.commit()
    assert result["ok"] is True
    assert result["action"] == "created"

    row = conn.execute(
        "SELECT * FROM hub_products WHERE external_id=?", ("yg-1-1",)
    ).fetchone()
    record = module.row_to_record(row)
    assert record["ops_note"] == "【运营提示】仅剩 3 件"
    assert record["desc_zh"] == "便携式榨汁杯，380ml 容量。"
    assert "运营提示" not in (record["desc_zh"] or "")


def test_ops_note_change_bumps_version_but_identical_payload_does_not(hub):
    module, conn = hub
    item = base_item()
    module.upsert_item(conn, "demo", item, "shop_publish", "job-1")
    conn.commit()

    again = module.upsert_item(conn, "demo", item, "shop_publish", "job-2")
    conn.commit()
    assert again["action"] == "unchanged"
    assert again["version"] == 1

    changed = module.upsert_item(
        conn, "demo", base_item(ops_note="【运营提示】仅剩 1 件"),
        "inventory_alert", "job-3",
    )
    conn.commit()
    assert changed["action"] == "updated"
    assert changed["version"] == 2

    row = conn.execute(
        "SELECT * FROM hub_products WHERE external_id=?", ("yg-1-1",)
    ).fetchone()
    assert module.row_to_record(row)["ops_note"] == "【运营提示】仅剩 1 件"
