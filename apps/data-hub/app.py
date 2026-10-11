# -*- coding: utf-8 -*-
"""商品知识数据中心 (data-hub)。

零第三方依赖：标准库 http.server + sqlite3。
职责：作为内容平台与电商系统之间的唯一事实来源。

契约要点
- 身份：每条记录由 (tenant_slug, external_id) 唯一确定，写入幂等
- 版本：内容哈希变化才 version+1，支撑增量同步
- 回执：电商侧上架后 ack 回写 published_product_id
- 检索：为 AI 客服输出结构化知识卡与数值白名单
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HOST = os.environ.get("HUB_HOST", "127.0.0.1")
PORT = int(os.environ.get("HUB_PORT", "8120"))
DB_PATH = os.environ.get(
    "HUB_DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data-hub.db"),
)
HUB_TOKENS = os.environ.get("HUB_TOKENS", "")
MAX_BODY = 12 * 1024 * 1024

STATUSES = {"draft", "approved", "published", "archived"}
WRITE_LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def token_map() -> dict:
    out = {}
    for part in (HUB_TOKENS or "").split(","):
        part = part.strip()
        if not part or ":" not in part:
            continue
        slug, token = part.split(":", 1)
        out[slug.strip()] = token.strip()
    return out


def authorized(handler) -> bool:
    tokens = token_map()
    if not tokens:
        return True
    header = handler.headers.get("X-Hub-Token") or ""
    if not header and handler.headers.get("Authorization", "").startswith("Bearer "):
        header = handler.headers.get("Authorization")[7:]
    tenant = handler.headers.get("X-Hub-Tenant") or ""
    if tenant and tenant in tokens:
        return tokens[tenant] == header
    return header in tokens.values()


# ---------------------------------------------------------------- schema

SCHEMA = """
CREATE TABLE IF NOT EXISTS hub_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT,
  subtitle TEXT,
  title_en TEXT,
  price REAL,
  currency TEXT DEFAULT 'CNY',
  stock INTEGER,
  category TEXT,
  brand TEXT,
  tags_json TEXT,
  selling_points_json TEXT,
  scenario TEXT,
  spec_json TEXT,
  faq_json TEXT,
  desc_zh TEXT,
  desc_en TEXT,
  images_json TEXT,
  video_url TEXT,
  declare_name_cn TEXT,
  declare_name_en TEXT,
  declare_value REAL,
  goods_type TEXT DEFAULT 'general',
  hs_code TEXT,
  logistics_note TEXT,
  status TEXT DEFAULT 'draft',
  source TEXT,
  source_job_id TEXT,
  content_hash TEXT,
  version INTEGER DEFAULT 1,
  published_product_id INTEGER,
  published_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(tenant_slug, external_id)
);
CREATE INDEX IF NOT EXISTS idx_hub_tenant_status ON hub_products(tenant_slug, status);
CREATE INDEX IF NOT EXISTS idx_hub_updated ON hub_products(updated_at);

CREATE TABLE IF NOT EXISTS hub_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug TEXT,
  external_id TEXT,
  action TEXT,
  version INTEGER,
  ok INTEGER DEFAULT 1,
  message TEXT,
  created_at TEXT
);
"""

JSON_FIELDS = {
    "tags": "tags_json",
    "selling_points": "selling_points_json",
    "spec": "spec_json",
    "faq": "faq_json",
    "images": "images_json",
}

SCALAR_FIELDS = [
    "title", "subtitle", "title_en", "price", "currency", "stock",
    "category", "brand", "scenario", "desc_zh", "desc_en", "video_url",
    "declare_name_cn", "declare_name_en", "declare_value", "goods_type",
    "hs_code", "logistics_note",
]


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def init_db() -> None:
    with WRITE_LOCK:
        conn = connect()
        try:
            conn.executescript(SCHEMA)
            conn.commit()
        finally:
            conn.close()


def dumps(value) -> str:
    if value is None:
        return "[]" if False else json.dumps(value if value is not None else [], ensure_ascii=False)
    return json.dumps(value, ensure_ascii=False)


def loads(raw, default):
    if not raw:
        return default
    try:
        value = json.loads(raw)
        return value if value is not None else default
    except Exception:
        return default


def number_or_none(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def int_or_none(value):
    n = number_or_none(value)
    return int(n) if n is not None else None


def normalize_tags(value):
    if value is None:
        return []
    if isinstance(value, str):
        return [t.strip() for t in re.split(r"[,，;；|/]", value) if t.strip()]
    return [str(t).strip() for t in value if str(t).strip()]


def normalize_points(value):
    if value is None:
        return []
    if isinstance(value, str):
        parts = re.split(r"[\n;；。]|(?<=[!?！？])\s*", value)
        return [p.strip(" -·•") for p in parts if p and p.strip(" -·•")]
    return [str(p).strip() for p in value if str(p).strip()]


def normalize_faq(value):
    if not value:
        return []
    out = []
    if isinstance(value, dict):
        for k, v in value.items():
            out.append({"q": str(k), "a": str(v)})
        return out
    for item in value:
        if isinstance(item, dict):
            q = str(item.get("q") or item.get("question") or "").strip()
            a = str(item.get("a") or item.get("answer") or "").strip()
            if q and a:
                out.append({"q": q, "a": a})
    return out


def normalize_spec(value):
    if not value:
        return {}
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items()}
    out = {}
    for item in value:
        if isinstance(item, dict):
            k = str(item.get("k") or item.get("name") or item.get("key") or "").strip()
            v = str(item.get("v") or item.get("val") or item.get("value") or "").strip()
            if k:
                out[k] = v
    return out


def normalize_images(value):
    if not value:
        return []
    if isinstance(value, str):
        return [value]
    return [str(v) for v in value if str(v).strip()]


def content_hash_of(item: dict) -> str:
    payload = {
        "title": item.get("title"),
        "subtitle": item.get("subtitle"),
        "title_en": item.get("title_en"),
        "price": item.get("price"),
        "stock": item.get("stock"),
        "category": item.get("category"),
        "brand": item.get("brand"),
        "tags": item.get("tags"),
        "selling_points": item.get("selling_points"),
        "scenario": item.get("scenario"),
        "spec": item.get("spec"),
        "faq": item.get("faq"),
        "desc_zh": item.get("desc_zh"),
        "desc_en": item.get("desc_en"),
        "images": item.get("images"),
        "video_url": item.get("video_url"),
        "declare_name_cn": item.get("declare_name_cn"),
        "declare_name_en": item.get("declare_name_en"),
        "declare_value": item.get("declare_value"),
        "goods_type": item.get("goods_type"),
        "hs_code": item.get("hs_code"),
        "logistics_note": item.get("logistics_note"),
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def row_to_record(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "tenant_slug": row["tenant_slug"],
        "external_id": row["external_id"],
        "title": row["title"],
        "subtitle": row["subtitle"],
        "title_en": row["title_en"],
        "price": row["price"],
        "currency": row["currency"] or "CNY",
        "stock": row["stock"],
        "category": row["category"],
        "brand": row["brand"],
        "tags": loads(row["tags_json"], []),
        "selling_points": loads(row["selling_points_json"], []),
        "scenario": row["scenario"],
        "spec": loads(row["spec_json"], {}),
        "faq": loads(row["faq_json"], []),
        "desc_zh": row["desc_zh"],
        "desc_en": row["desc_en"],
        "images": loads(row["images_json"], []),
        "video_url": row["video_url"],
        "declare_name_cn": row["declare_name_cn"],
        "declare_name_en": row["declare_name_en"],
        "declare_value": row["declare_value"],
        "goods_type": row["goods_type"] or "general",
        "hs_code": row["hs_code"],
        "logistics_note": row["logistics_note"],
        "status": row["status"],
        "source": row["source"],
        "source_job_id": row["source_job_id"],
        "content_hash": row["content_hash"],
        "version": row["version"],
        "published_product_id": row["published_product_id"],
        "published_at": row["published_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def upsert_item(conn: sqlite3.Connection, tenant: str, raw: dict, source: str, job_id: str) -> dict:
    external_id = str(raw.get("external_id") or raw.get("id") or "").strip()
    if not external_id:
        return {"external_id": None, "ok": False, "action": "skipped", "message": "缺少 external_id"}

    item = {
        "external_id": external_id,
        "title": (raw.get("title") or raw.get("name") or "").strip() or None,
        "subtitle": (raw.get("subtitle") or raw.get("selling_point_short") or "").strip() or None,
        "title_en": (raw.get("title_en") or raw.get("name_en") or "").strip() or None,
        "price": number_or_none(raw.get("price")),
        "currency": (raw.get("currency") or "CNY").strip() or "CNY",
        "stock": int_or_none(raw.get("stock") if raw.get("stock") is not None else raw.get("number")),
        "category": (raw.get("category") or raw.get("cid_name") or "").strip() or None,
        "brand": (raw.get("brand") or "").strip() or None,
        "tags": normalize_tags(raw.get("tags") or raw.get("keywords")),
        "selling_points": normalize_points(raw.get("selling_points") or raw.get("sell_points")),
        "scenario": (raw.get("scenario") or "").strip() or None,
        "spec": normalize_spec(raw.get("spec") or raw.get("specs") or raw.get("attributes")),
        "faq": normalize_faq(raw.get("faq")),
        "desc_zh": (raw.get("desc_zh") or raw.get("introduce") or raw.get("description") or "").strip() or None,
        "desc_en": (raw.get("desc_en") or "").strip() or None,
        "images": normalize_images(raw.get("images") or raw.get("pics")),
        "video_url": (raw.get("video_url") or "").strip() or None,
        "declare_name_cn": (raw.get("declare_name_cn") or "").strip() or None,
        "declare_name_en": (raw.get("declare_name_en") or "").strip() or None,
        "declare_value": number_or_none(raw.get("declare_value")),
        "goods_type": (raw.get("goods_type") or "general").strip() or "general",
        "hs_code": (raw.get("hs_code") or "").strip() or None,
        "logistics_note": (raw.get("logistics_note") or "").strip() or None,
    }

    incoming_hash = content_hash_of(item)
    existing = conn.execute(
        "SELECT * FROM hub_products WHERE tenant_slug=? AND external_id=?",
        (tenant, external_id),
    ).fetchone()

    ts = now_iso()
    if existing is None:
        status = "draft"
        version = 1
        published_product_id = None
        conn.execute(
            """INSERT INTO hub_products
            (tenant_slug, external_id, title, subtitle, title_en, price, currency, stock,
             category, brand, tags_json, selling_points_json, scenario, spec_json, faq_json,
             desc_zh, desc_en, images_json, video_url, declare_name_cn, declare_name_en,
             declare_value, goods_type, hs_code, logistics_note, status, source, source_job_id,
             content_hash, version, published_product_id, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                tenant, external_id, item["title"], item["subtitle"], item["title_en"],
                item["price"], item["currency"], item["stock"], item["category"], item["brand"],
                dumps(item["tags"]), dumps(item["selling_points"]), item["scenario"],
                dumps(item["spec"]), dumps(item["faq"]), item["desc_zh"], item["desc_en"],
                dumps(item["images"]), item["video_url"], item["declare_name_cn"],
                item["declare_name_en"], item["declare_value"], item["goods_type"],
                item["hs_code"], item["logistics_note"], status, source, job_id,
                incoming_hash, version, published_product_id, ts, ts,
            ),
        )
        action = "created"
    else:
        old_status = existing["status"]
        published_product_id = existing["published_product_id"]
        if existing["content_hash"] == incoming_hash:
            conn.execute(
                "UPDATE hub_products SET source_job_id=?, updated_at=? WHERE id=?",
                (job_id, ts, existing["id"]),
            )
            conn.execute(
                "INSERT INTO hub_sync_log (tenant_slug, external_id, action, version, ok, message, created_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (tenant, external_id, "unchanged", existing["version"], 1, "内容无变化", ts),
            )
            return {
                "external_id": external_id,
                "ok": True,
                "action": "unchanged",
                "version": existing["version"],
                "status": old_status,
            }
        version = int(existing["version"] or 1) + 1
        # 内容变更后回到待上架态，但保留已发布商品 ID 便于更新而非新建
        status = "published" if old_status == "published" else "approved"
        conn.execute(
            """UPDATE hub_products SET
                title=?, subtitle=?, title_en=?, price=?, currency=?, stock=?, category=?, brand=?,
                tags_json=?, selling_points_json=?, scenario=?, spec_json=?, faq_json=?,
                desc_zh=?, desc_en=?, images_json=?, video_url=?, declare_name_cn=?, declare_name_en=?,
                declare_value=?, goods_type=?, hs_code=?, logistics_note=?,
                status=?, source=?, source_job_id=?, content_hash=?, version=?, updated_at=?
               WHERE id=?""",
            (
                item["title"], item["subtitle"], item["title_en"], item["price"], item["currency"],
                item["stock"], item["category"], item["brand"], dumps(item["tags"]),
                dumps(item["selling_points"]), item["scenario"], dumps(item["spec"]),
                dumps(item["faq"]), item["desc_zh"], item["desc_en"], dumps(item["images"]),
                item["video_url"], item["declare_name_cn"], item["declare_name_en"],
                item["declare_value"], item["goods_type"], item["hs_code"], item["logistics_note"],
                status, source, job_id, incoming_hash, version, ts, existing["id"],
            ),
        )
        action = "updated"

    conn.execute(
        "INSERT INTO hub_sync_log (tenant_slug, external_id, action, version, ok, message, created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (tenant, external_id, action, version, 1, source or "", ts),
    )
    return {
        "external_id": external_id,
        "ok": True,
        "action": action,
        "version": version,
        "status": status,
        "title": item["title"],
    }


# ---------------------------------------------------------------- search

TOKEN_RE = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]{1,4}")


def tokenize(text: str) -> list:
    if not text:
        return []
    return [t for t in TOKEN_RE.findall(str(text).lower()) if len(t) > 1 or t.isdigit()]


def score_record(rec: dict, tokens: list, raw_query: str) -> float:
    if not tokens:
        return 0.0
    score = 0.0
    title = str(rec.get("title") or "")
    title_low = title.lower()
    if raw_query and raw_query.lower() in title_low:
        score += 20
    for tok in tokens:
        if tok in title_low:
            score += 6
        for tag in rec.get("tags") or []:
            if tok in str(tag).lower():
                score += 4
                break
        if rec.get("category") and tok in str(rec["category"]).lower():
            score += 3
        if rec.get("brand") and tok in str(rec["brand"]).lower():
            score += 3
        for point in rec.get("selling_points") or []:
            if tok in str(point).lower():
                score += 1.5
                break
        if rec.get("scenario") and tok in str(rec["scenario"]).lower():
            score += 1
        if rec.get("desc_zh") and tok in str(rec["desc_zh"]).lower():
            score += 0.6
        for faq in rec.get("faq") or []:
            if tok in str(faq.get("q") or "").lower():
                score += 3
                break
    return score


def build_knowledge_card(rec: dict, max_points: int = 5, max_faq: int = 3) -> dict:
    points = [str(p) for p in (rec.get("selling_points") or []) if str(p).strip()][:max_points]
    faq = [{"q": f.get("q"), "a": f.get("a")} for f in (rec.get("faq") or [])][:max_faq]
    spec = dict(rec.get("spec") or {})
    desc = str(rec.get("desc_zh") or "")
    if len(desc) > 220:
        desc = desc[:220].rstrip() + "..."
    numbers = set()
    if rec.get("price") is not None:
        numbers.add(round(float(rec["price"]), 2))
    for key, val in spec.items():
        m = re.search(r"(\d+(?:\.\d+)?)", str(val))
        if m:
            numbers.add(round(float(m.group(1)), 2))
    return {
        "external_id": rec.get("external_id"),
        "title": rec.get("title"),
        "price": rec.get("price"),
        "currency": rec.get("currency") or "CNY",
        "stock": rec.get("stock"),
        "status": rec.get("status"),
        "category": rec.get("category"),
        "brand": rec.get("brand"),
        "scenario": rec.get("scenario"),
        "selling_points": points,
        "spec": spec,
        "faq": faq,
        "desc": desc,
        "images": (rec.get("images") or [])[:3],
        "product_id": rec.get("published_product_id"),
        "allowed_numbers": sorted(numbers),
    }


def search_products(tenant: str, query: str, limit: int, only_published: bool) -> list:
    conn = connect()
    try:
        if only_published:
            rows = conn.execute(
                "SELECT * FROM hub_products WHERE tenant_slug=? AND status IN ('published','approved')",
                (tenant,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM hub_products WHERE tenant_slug=? AND status != 'archived'",
                (tenant,),
            ).fetchall()
    finally:
        conn.close()

    tokens = tokenize(query)
    scored = []
    for row in rows:
        rec = row_to_record(row)
        sc = score_record(rec, tokens, query)
        if sc <= 0:
            continue
        scored.append((sc, rec))
    scored.sort(key=lambda x: (-x[0], str(x[1].get("title") or "")))
    return [build_knowledge_card(rec) for _, rec in scored[:limit]]


# ---------------------------------------------------------------- http


class Handler(BaseHTTPRequestHandler):
    server_version = "data-hub/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[hub] %s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _auth(self) -> bool:
        if not authorized(self):
            self._send(401, {"ok": False, "error": "unauthorized"})
            return False
        return True

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = {k: v[0] for k, v in parse_qs(parsed.query).items()}

        if path == "/health":
            return self._send(200, {"ok": True, "service": "data-hub", "db": DB_PATH, "time": now_iso()})

        if not self._auth():
            return

        if path == "/hub/stats":
            tenant = qs.get("tenant") or self.headers.get("X-Hub-Tenant") or ""
            conn = connect()
            try:
                if tenant:
                    rows = conn.execute(
                        "SELECT status, COUNT(*) AS n FROM hub_products WHERE tenant_slug=? GROUP BY status",
                        (tenant,),
                    ).fetchall()
                    total = conn.execute(
                        "SELECT COUNT(*) AS n FROM hub_products WHERE tenant_slug=?", (tenant,)
                    ).fetchone()["n"]
                else:
                    rows = conn.execute(
                        "SELECT status, COUNT(*) AS n FROM hub_products GROUP BY status"
                    ).fetchall()
                    total = conn.execute("SELECT COUNT(*) AS n FROM hub_products").fetchone()["n"]
            finally:
                conn.close()
            return self._send(200, {
                "ok": True,
                "tenant": tenant or None,
                "total": total,
                "by_status": {r["status"]: r["n"] for r in rows},
            })

        if path == "/hub/products":
            tenant = qs.get("tenant") or self.headers.get("X-Hub-Tenant") or ""
            if not tenant:
                return self._send(400, {"ok": False, "error": "tenant is required"})
            status = qs.get("status")
            since = qs.get("since")
            q = qs.get("q")
            limit = max(1, min(int(qs.get("limit") or 50), 500))
            offset = max(0, int(qs.get("offset") or 0))
            conn = connect()
            try:
                sql = "SELECT * FROM hub_products WHERE tenant_slug=?"
                args = [tenant]
                if status:
                    sql += " AND status=?"
                    args.append(status)
                if since:
                    sql += " AND updated_at > ?"
                    args.append(since)
                if q:
                    sql += " AND (title LIKE ? OR tags_json LIKE ? OR desc_zh LIKE ?)"
                    like = f"%{q}%"
                    args.extend([like, like, like])
                sql += " ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?"
                args.extend([limit, offset])
                rows = conn.execute(sql, args).fetchall()
            finally:
                conn.close()
            return self._send(200, {
                "ok": True,
                "count": len(rows),
                "items": [row_to_record(r) for r in rows],
            })

        m = re.match(r"^/hub/products/([^/]+)/([^/]+)$", path)
        if m:
            tenant, external_id = m.group(1), m.group(2)
            conn = connect()
            try:
                row = conn.execute(
                    "SELECT * FROM hub_products WHERE tenant_slug=? AND external_id=?",
                    (tenant, external_id),
                ).fetchone()
            finally:
                conn.close()
            if not row:
                return self._send(404, {"ok": False, "error": "not found"})
            return self._send(200, {"ok": True, "item": row_to_record(row)})

        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if not self._auth():
            return

        try:
            body = self._read_body()
        except ValueError as exc:
            return self._send(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            return self._send(400, {"ok": False, "error": f"invalid json: {exc}"})

        if path == "/hub/ingest":
            tenant = body.get("tenant_slug") or self.headers.get("X-Hub-Tenant") or ""
            if not tenant:
                return self._send(400, {"ok": False, "error": "tenant_slug is required"})
            items = body.get("items") or []
            if not isinstance(items, list) or not items:
                return self._send(400, {"ok": False, "error": "items must be a non-empty array"})
            source = body.get("source") or "content_create"
            job_id = body.get("job_id") or body.get("source_job_id") or ""
            results = []
            with WRITE_LOCK:
                conn = connect()
                try:
                    for raw in items:
                        if not isinstance(raw, dict):
                            results.append({"ok": False, "action": "skipped", "message": "条目不是对象"})
                            continue
                        try:
                            results.append(upsert_item(conn, tenant, raw, source, str(job_id)))
                        except Exception as exc:
                            results.append({"external_id": raw.get("external_id"), "ok": False,
                                            "action": "error", "message": str(exc)})
                    conn.commit()
                finally:
                    conn.close()
            ok_n = sum(1 for r in results if r.get("ok"))
            return self._send(200, {
                "ok": ok_n > 0,
                "tenant_slug": tenant,
                "received": len(items),
                "ok_count": ok_n,
                "created": sum(1 for r in results if r.get("action") == "created"),
                "updated": sum(1 for r in results if r.get("action") == "updated"),
                "unchanged": sum(1 for r in results if r.get("action") == "unchanged"),
                "error_count": sum(1 for r in results if not r.get("ok")),
                "results": results,
            })

        if path == "/hub/search":
            tenant = body.get("tenant_slug") or body.get("tenant") or self.headers.get("X-Hub-Tenant") or ""
            query = str(body.get("query") or body.get("q") or "").strip()
            if not tenant:
                return self._send(400, {"ok": False, "error": "tenant_slug is required"})
            if not query:
                return self._send(400, {"ok": False, "error": "query is required"})
            limit = max(1, min(int(body.get("limit") or 5), 20))
            only_published = bool(body.get("published_only", True))
            cards = search_products(tenant, query, limit, only_published)
            return self._send(200, {
                "ok": True,
                "query": query,
                "count": len(cards),
                "cards": cards,
            })

        m = re.match(r"^/hub/products/([^/]+)/([^/]+)/ack$", path)
        if m:
            tenant, external_id = m.group(1), m.group(2)
            product_id = body.get("product_id")
            status = (body.get("status") or "published").strip()
            if status not in STATUSES:
                return self._send(400, {"ok": False, "error": f"非法 status: {status}"})
            ts = now_iso()
            with WRITE_LOCK:
                conn = connect()
                try:
                    row = conn.execute(
                        "SELECT id FROM hub_products WHERE tenant_slug=? AND external_id=?",
                        (tenant, external_id),
                    ).fetchone()
                    if not row:
                        return self._send(404, {"ok": False, "error": "not found"})
                    conn.execute(
                        "UPDATE hub_products SET status=?, published_product_id=?, published_at=?, updated_at=? WHERE id=?",
                        (status, int_or_none(product_id), ts, ts, row["id"]),
                    )
                    conn.execute(
                        "INSERT INTO hub_sync_log (tenant_slug, external_id, action, version, ok, message, created_at)"
                        " VALUES (?,?,?,?,?,?,?)",
                        (tenant, external_id, "ack", 0, 1, f"product_id={product_id}", ts),
                    )
                    conn.commit()
                finally:
                    conn.close()
            return self._send(200, {"ok": True, "external_id": external_id, "status": status,
                                    "product_id": int_or_none(product_id)})

        m = re.match(r"^/hub/products/([^/]+)/([^/]+)/status$", path)
        if m:
            tenant, external_id = m.group(1), m.group(2)
            status = (body.get("status") or "").strip()
            if status not in STATUSES:
                return self._send(400, {"ok": False, "error": f"非法 status: {status}"})
            with WRITE_LOCK:
                conn = connect()
                try:
                    cur = conn.execute(
                        "UPDATE hub_products SET status=?, updated_at=? WHERE tenant_slug=? AND external_id=?",
                        (status, now_iso(), tenant, external_id),
                    )
                    conn.commit()
                    if cur.rowcount == 0:
                        return self._send(404, {"ok": False, "error": "not found"})
                finally:
                    conn.close()
            return self._send(200, {"ok": True, "external_id": external_id, "status": status})

        return self._send(404, {"ok": False, "error": "not found"})


def main():
    init_db()
    print(f"[data-hub] db={DB_PATH}")
    print(f"[data-hub] listening http://{HOST}:{PORT}")
    print(f"[data-hub] tokens={'configured' if token_map() else 'open (no HUB_TOKENS)'}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
