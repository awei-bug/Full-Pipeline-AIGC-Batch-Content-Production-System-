import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from app.queue import MemoryJobQueue, RedisJobQueue
from app.storage import LocalObjectStore, build_object_store


class ObjectStoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_store_roundtrip_and_uri(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = LocalObjectStore(Path(tmp) / "gen")
            ref = await store.put("ip-content/b1/i1.json", json.dumps({"ok": True}))
            self.assertTrue(await store.exists("ip-content/b1/i1.json"))
            self.assertTrue(ref.uri.startswith("local://"))
            raw = await store.get("ip-content/b1/i1.json")
            self.assertEqual(json.loads(raw), {"ok": True})
            await store.delete("ip-content/b1/i1.json")
            self.assertFalse(await store.exists("ip-content/b1/i1.json"))

    async def test_build_object_store_backends(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsInstance(build_object_store("local", local_dir=tmp), LocalObjectStore)
        self.assertIsNone(build_object_store("none"))
        # 未提供 bucket 时 S3 后端应报错而非静默返回。
        with self.assertRaises(ValueError):
            build_object_store("s3", bucket=None)


class MemoryQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_enqueue_dequeue_remove_and_priority(self):
        q: MemoryJobQueue = MemoryJobQueue()
        await q.enqueue("a", priority=0.0)
        await q.enqueue("b", priority=5.0)  # 高优先级先出
        await q.enqueue("c", priority=0.0)
        self.assertEqual(await q.dequeue(10), ["b", "a", "c"])
        self.assertEqual(await q.size(), 3)
        await q.remove("a")
        self.assertEqual(await q.dequeue(10), ["b", "c"])
        self.assertEqual(await q.size(), 2)


class RedisQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_redis_queue_operations(self):
        q = RedisJobQueue(_FakeRedis())
        await q.enqueue("a")
        await q.enqueue("b")
        await q.enqueue("c")
        self.assertEqual(await q.dequeue(2), ["a", "b"])
        self.assertEqual(await q.size(), 3)
        await q.remove("a")
        self.assertEqual(await q.dequeue(10), ["b", "c"])


class _FakeRedis:
    """极简内存 Redis 客户端，仅实现 RedisJobQueue 用到的有序集合方法。"""

    def __init__(self):
        self.z: dict[str, dict[str, float]] = {}

    async def zadd(self, key, mapping):
        self.z.setdefault(key, {}).update(mapping)
        return len(mapping)

    async def zrange(self, key, a, b):
        items = sorted(self.z.get(key, {}).items(), key=lambda kv: kv[1])
        return [k for k, _ in items[a:b + 1]]

    async def zrem(self, key, member):
        self.z.get(key, {}).pop(member, None)
        return 1

    async def zcard(self, key):
        return len(self.z.get(key, {}))


if __name__ == "__main__":
    unittest.main()
