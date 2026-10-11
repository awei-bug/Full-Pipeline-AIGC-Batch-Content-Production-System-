#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证 desc_en / sell_points / declare_name_en 是否落库。

启动两个服务，做一次 push，从数据库读回商品，断言跨境字段非空。
"""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(r"F:\Python_code\content_create")
SHOP_ROOT = Path(r"F:\Python_code\Flask项目\flask_shop")
SHOP_DB = SHOP_ROOT / "instance" / "ecommerce_shop.db"

SHOP_TOKEN_VALUE = "dev-integration-token-2026"
SHOP_TOKEN_LINE = f"demo:{SHOP_TOKEN_VALUE}"
COMMERCE_URL = "http://127.0.0.1:5000/products/import-pack/integration/"
API_PORT = 3100
SHOP_PORT = 5000

procs: list[subprocess.Popen] = []


def port_busy(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return False
    except OSError:
        return True
    finally:
        s.close()


def kill_port(port: int) -> None:
    if not port_busy(port):
        return
    try:
        out = subprocess.check_output(["netstat", "-ano"], text=True, errors="replace")
    except Exception:
        return
    pids: set[int] = set()
    for line in out.splitlines():
        if f":{port} " in line and "LISTENING" in line:
            parts = line.split()
            try:
                pids.add(int(parts[-1]))
            except (ValueError, IndexError):
                pass
    for pid in pids:
        try:
            subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except Exception:
            pass
    time.sleep(1)


def wait_http(url: str, label: str, timeout: float = 30.0, headers=None) -> tuple[int, str]:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        req = urllib.request.Request(url, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=3) as r:
                return r.status, r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            last = str(e)
            time.sleep(0.5)
    raise RuntimeError(f"{label} 在 {timeout}s 内未响应: {last}")


def start_shop() -> subprocess.Popen:
    print(">>> 启动电商服务 (Flask, 端口 5000)")
    kill_port(SHOP_PORT)
    env = os.environ.copy()
    env["INTEGRATION_TOKENS"] = SHOP_TOKEN_LINE
    env["DATABASE_URL"] = f"sqlite:///{SHOP_DB}"
    env["PYTHONUNBUFFERED"] = "1"
    log = open(ROOT / "shop.log", "w", encoding="utf-8", errors="replace")
    p = subprocess.Popen(
        [str(SHOP_ROOT / ".venv" / "Scripts" / "python.exe"), "-u", "manager.py"],
        cwd=str(SHOP_ROOT),
        env=env,
        stdout=log, stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
    )
    procs.append(p)
    code, body = wait_http(f"http://127.0.0.1:{SHOP_PORT}/health/", "shop")
    print(f"   shop /health -> {code}")
    return p


def start_api() -> subprocess.Popen:
    print(">>> 启动 content_create api-server (端口 3100)")
    kill_port(API_PORT)
    env = os.environ.copy()
    env["COMMERCE_IMPORT_URL"] = COMMERCE_URL
    env["COMMERCE_IMPORT_TOKEN"] = SHOP_TOKEN_VALUE
    env["COMMERCE_TENANT_SLUG"] = "demo"
    log = open(ROOT / "api.log", "w", encoding="utf-8", errors="replace")
    p = subprocess.Popen(
        [r"C:\Users\徐炜\.workbuddy\binaries\node\versions\22.22.2-2\node.exe",
         str(ROOT / "scripts" / "seed-demo-pack.js")],
        cwd=str(ROOT), env=env,
        stdout=log, stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
    )
    procs.append(p)
    code, body = wait_http(f"http://127.0.0.1:{API_PORT}/api/health", "api")
    print(f"   api /api/health -> {code}")
    return p


def cleanup():
    for p in procs:
        try:
            p.send_signal(signal.CTRL_BREAK_EVENT)
        except Exception:
            pass
    for p in procs:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                p.kill()
            except Exception:
                pass


def db_query(sql: str, params=()) -> list[tuple]:
    import sqlite3
    con = sqlite3.connect(str(SHOP_DB))
    cur = con.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    con.close()
    return rows


def main():
    try:
        start_shop()
        start_api()

        # 取最新一批商品 id 作为"新增"基线
        before = max([r[0] for r in db_query("SELECT id FROM t_product")], default=0)
        print(f"\n>>> 当前 t_product 最大 id = {before}")

        print("\n>>> 取第一个 content job")
        code, body = wait_http(f"http://127.0.0.1:{API_PORT}/api/content-jobs", "jobs")
        jobs_data = json.loads(body)
        items = []
        if isinstance(jobs_data, dict):
            data = jobs_data.get("data")
            if isinstance(data, dict):
                items = data.get("items") or []
            elif isinstance(data, list):
                items = data
        if not items:
            print("   无 job 可用")
            cleanup(); sys.exit(2)
        job_id = items[0]["id"]
        print(f"   jobId: {job_id}")

        print("\n>>> 预览 + 直推")
        code, body = wait_http(
            f"http://127.0.0.1:{API_PORT}/api/listing-packs/{job_id}/preview", "preview")
        preview = json.loads(body)
        pending = preview.get("data", {}).get("pending") or []
        prices = {p["productId"]: str(p.get("suggestedPrice") or "89") for p in pending}

        payload = json.dumps({"prices": prices, "publish": False, "defaultStock": 50}).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{API_PORT}/api/listing-packs/{job_id}/push",
            data=payload, headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                push_status, push_body = r.status, r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            push_status, push_body = e.code, e.read().decode("utf-8", errors="replace")
        print(f"   push -> {push_status}")
        result = json.loads(push_body).get("data", {}) if push_status == 200 else {}
        print(f"   createdCount={result.get('createdCount')} errors={result.get('errorCount')}")

        print("\n>>> 数据库反查跨境字段")
        rows = db_query(
            "SELECT id, name, price, state, "
            "length(desc_en) as desc_en_len, length(sell_points) as sell_points_len, "
            "length(declare_name_en) as declare_name_en_len, "
            "goods_type, hs_code, length(declare_value) as dv_len, "
            "length(logistics_note) as ln_len, length(declare_name_cn) as dnc_len "
            "FROM t_product WHERE id > ? ORDER BY id",
            (before,),
        )
        print(f"   新增商品 {len(rows)} 条")
        print(f"   {'id':>4} {'name':<14} {'price':>6} {'st':>2} {'desc_en':>7} {'sp':>4} {'dne':>4} {'dt':>10} hs")
        all_ok = True
        for r in rows:
            pid, name, price, state, de, sp, dne, gt, hs, dv, ln, dnc = r
            ok = (de or 0) > 0 and (sp or 0) > 0
            if not ok:
                all_ok = False
            print(f"   {pid:>4} {name:<14} {price:>6} {state:>2} {de or 0:>7} {sp or 0:>4} {dne or 0:>4} {str(gt):>10} {hs or '-'}")
        print()
        if all_ok:
            print(">>> [PASS] 所有新增商品的 desc_en / sell_points 均已落库")
        else:
            print(">>> [FAIL] 有商品的跨境字段为空")
            sys.exit(1)
    finally:
        cleanup()


if __name__ == "__main__":
    main()
