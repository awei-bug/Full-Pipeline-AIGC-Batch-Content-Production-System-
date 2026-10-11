from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Any

import httpx


class LLMRouter:
    """Shared connections, bounded requests and provider-level circuit breakers."""

    def __init__(self, providers: list[dict[str, Any]], *, concurrency: int = 12,
                 timeout: float = 45, requests_per_minute: int = 60,
                 client_factory=httpx.AsyncClient, rate_redis=None):
        self.providers = [provider for provider in providers if provider.get("api_key")]
        self.clients = [client_factory(base_url=p["base_url"].rstrip("/"),
                                       headers={"Authorization": f"Bearer {p['api_key']}"},
                                       timeout=timeout, limits=httpx.Limits(max_connections=concurrency),
                                       trust_env=p.get("trust_env", True))
                        for p in self.providers]
        self.semaphore = asyncio.Semaphore(concurrency)
        self.failures = [0] * len(self.providers)
        self.open_until = [0.0] * len(self.providers)
        self.in_flight = [0] * len(self.providers)
        self.requests_per_minute = max(1, requests_per_minute)
        self.request_times = [deque() for _ in self.providers]
        self.rate_lock = asyncio.Lock()
        self.rate_redis = rate_redis

    async def _reserve(self, index: int):
        while True:
            if self.rate_redis is not None:
                current = time.time()
                key = f"ip:llm-rate:{self.providers[index]['name']}:{int(current // 60)}"
                count = await self.rate_redis.eval(
                    "local n = redis.call('incr', KEYS[1]); if n == 1 then redis.call('expire', KEYS[1], 62) end; return n",
                    1, key,
                )
                if count <= self.requests_per_minute:
                    return
                await asyncio.sleep(60 - current % 60 + 0.05)
                continue
            async with self.rate_lock:
                queue = self.request_times[index]
                current = time.monotonic()
                while queue and current - queue[0] >= 60:
                    queue.popleft()
                if len(queue) < self.requests_per_minute:
                    queue.append(current)
                    return
                wait = 60 - (current - queue[0])
            await asyncio.sleep(max(wait, 0.01))

    async def close(self):
        for client in self.clients:
            await client.aclose()

    async def complete(self, messages: list[dict[str, str]], tools: list[dict] | None = None,
                       *, temperature: float = 0.5) -> dict[str, Any]:
        if not self.providers:
            raise RuntimeError("未配置文本模型密钥，请设置 AGNES_API_KEY 或 MODELSCOPE_API_TOKEN。")
        last_error: Exception | None = None
        async with self.semaphore:
            order = sorted(range(len(self.providers)), key=lambda i: (
                self.open_until[i] > time.monotonic(),
                len(self.request_times[i]) >= self.requests_per_minute,
                self.in_flight[i],
            ))
            for index in order:
                if self.open_until[index] > time.monotonic():
                    continue
                self.in_flight[index] += 1
                try:
                    await self._reserve(index)
                    body: dict[str, Any] = {"model": self.providers[index]["model"],
                                            "messages": messages, "temperature": temperature}
                    if tools:
                        body["tools"] = tools
                        body["tool_choice"] = "auto"
                    response = await self.clients[index].post("/chat/completions", json=body)
                    if response.status_code in (408, 429) or response.status_code >= 500:
                        raise httpx.HTTPStatusError("模型服务暂不可用", request=response.request, response=response)
                    response.raise_for_status()
                    payload = response.json()
                    message = payload["choices"][0]["message"]
                    if not message.get("content") and not message.get("tool_calls"):
                        raise ValueError("模型返回空内容")
                    self.failures[index] = 0
                    return {"message": message, "usage": payload.get("usage") or {},
                            "model": self.providers[index]["model"]}
                except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPStatusError, ValueError, KeyError, IndexError) as exc:
                    # Bad credentials and invalid requests are configuration errors, not failover events.
                    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (400, 401, 403):
                        raise RuntimeError(f"{self.providers[index]['name']} 模型配置错误 ({exc.response.status_code})") from exc
                    last_error = exc
                    self.failures[index] += 1
                    if self.failures[index] >= 3:
                        self.open_until[index] = time.monotonic() + 30
                finally:
                    self.in_flight[index] -= 1
        raise RuntimeError(f"所有可用模型均调用失败：{last_error or '熔断中'}")
