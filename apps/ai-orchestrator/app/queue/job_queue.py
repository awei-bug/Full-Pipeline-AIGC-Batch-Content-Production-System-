from __future__ import annotations

import abc
import time
from typing import Any


class JobQueue(abc.ABC):
    """任务队列抽象：把"待生成章节"的调度与具体存储后端解耦。

    语义：enqueue 入队；dequeue(limit) 取出最多 limit 个就绪项（预览，不消费），
    实际消费由 run_item 完成后调用 remove 完成；recover 在进程重启后重新认领未完成项。
    """

    @abc.abstractmethod
    async def enqueue(self, item_id: str, priority: float = 0.0) -> None:
        ...

    @abc.abstractmethod
    async def dequeue(self, limit: int) -> list[str]:
        """取出最多 limit 个就绪项 id（预览，不消费）。"""

    @abc.abstractmethod
    async def remove(self, item_id: str) -> None:
        ...

    @abc.abstractmethod
    async def peek(self, limit: int) -> list[str]:
        ...

    @abc.abstractmethod
    async def size(self) -> int:
        ...

    async def recover(self) -> None:  # 默认无操作；由具体后端或 store 负责。
        return None


class MemoryJobQueue(JobQueue):
    """内存任务队列：单机/开发模式下的真实队列，支持优先级与确定性出队。"""

    def __init__(self) -> None:
        self._items: dict[str, tuple[float, float]] = {}  # item_id -> (priority, seq)
        self._removed: set[str] = set()
        self._seq = 0.0

    async def enqueue(self, item_id: str, priority: float = 0.0) -> None:
        self._removed.discard(item_id)
        self._seq += 1
        self._items[item_id] = (priority, self._seq)

    async def dequeue(self, limit: int) -> list[str]:
        return self._ready(limit)

    async def peek(self, limit: int) -> list[str]:
        return self._ready(limit)

    async def remove(self, item_id: str) -> None:
        self._removed.add(item_id)
        self._items.pop(item_id, None)

    async def size(self) -> int:
        return len(self._items) - len(self._removed & set(self._items))

    def _ready(self, limit: int) -> list[str]:
        # 优先级高（priority 值大）的先出，同优先级按入队顺序（seq）先出。
        ordered = sorted(
            ((pid, meta) for pid, meta in self._items.items() if pid not in self._removed),
            key=lambda kv: (-kv[1][0], kv[1][1]),
        )
        return [pid for pid, _ in ordered[: max(0, limit)]]


class RedisJobQueue(JobQueue):
    """基于 Redis 有序集合的生产级任务队列：跨进程、可持久、支持优先级。"""

    KEY = "ip:queue"

    def __init__(self, client) -> None:
        self.client = client

    async def enqueue(self, item_id: str, priority: float = 0.0) -> None:
        # score = 高优先级(负) + 时间戳，保证优先级高且先入队的先出。
        score = -priority * 1e12 + time.time()
        await self.client.zadd(self.KEY, {item_id: score})

    async def dequeue(self, limit: int) -> list[str]:
        return await self.client.zrange(self.KEY, 0, max(0, limit) - 1)

    async def peek(self, limit: int) -> list[str]:
        return await self.client.zrange(self.KEY, 0, max(0, limit) - 1)

    async def remove(self, item_id: str) -> None:
        await self.client.zrem(self.KEY, item_id)

    async def size(self) -> int:
        return await self.client.zcard(self.KEY)


def build_queue(backend: str, *, client=None, local_dir: str | None = None) -> JobQueue:
    """按后端构建队列：'redis' 需 client；其余回退内存队列。"""
    if (backend or "").strip().lower() == "redis" and client is not None:
        return RedisJobQueue(client)
    return MemoryJobQueue()
