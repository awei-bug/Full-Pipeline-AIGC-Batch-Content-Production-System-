from __future__ import annotations

import asyncio
import json
from typing import Any, Iterable

import httpx
from langchain_core.tools import tool
from langchain_core.utils.function_calling import convert_to_openai_tool

from ..ip_content.lore import search_lore


async def _web_search(query: str, search_key: str) -> str:
    if not search_key:
        return "联网搜索未配置；仅使用提供的IP设定，不推断外部事实。"
    async with httpx.AsyncClient(timeout=12) as client:
        response = await client.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": query, "count": 3},
            headers={"X-Subscription-Token": search_key},
        )
        response.raise_for_status()
        results = response.json().get("web", {}).get("results", [])
        return "\n".join(
            f"{r.get('title')}: {r.get('description')} ({r.get('url')})" for r in results
        )[:3000]


def _build_tools(lore: str, search_key: str) -> dict[str, Any]:
    @tool
    def query_ip_lore(query: str) -> str:
        """Look up canonical facts from the supplied IP setting library."""
        return search_lore(lore, query)

    async def web_search(query: str) -> str:
        """Search public web references; results are non-canonical and need verification."""
        return await _web_search(query, search_key)

    return {"query_ip_lore": query_ip_lore, "web_search": web_search}


def clip(value: str, limit: int) -> str:
    return " ".join(str(value).split())[:limit]


async def call_stage(
    router,
    system: str,
    user_text: str,
    *,
    enabled_tools: Iterable[str] = (),
    lore: str = "",
    search_key: str = "",
    base_usage: dict[str, int] | None = None,
    on_stage=None,
    assert_lease=None,
    stage_name: str = "llm",
) -> tuple[str, dict[str, int], str]:
    """单次 LLM 阶段调用，含工具循环与指数退避重试。

    复用 ip_content.graph 的既有协议：usage 从 `base_usage` 累加，
    保证跨阶段 token 统计与旧链路一致。
    """
    if on_stage:
        await on_stage(stage_name)
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user_text}]
    tool_map = _build_tools(lore, search_key) if enabled_tools else {}
    available = {name: tool_map[name] for name in enabled_tools if name in tool_map}
    definitions = [convert_to_openai_tool(t) for t in available.values()] or None
    usage: dict[str, int] = dict(base_usage or {})
    for attempt in range(3):
        try:
            result = await router.complete(messages, definitions)
            for key, value in (result.get("usage") or {}).items():
                if isinstance(value, int):
                    usage[key] = usage.get(key, 0) + value
            message = result["message"]
            if message.get("tool_calls"):
                messages.append(message)
                for call in message["tool_calls"][:3]:
                    name = call.get("function", {}).get("name")
                    function = available.get(name)
                    try:
                        arguments = json.loads(call.get("function", {}).get("arguments") or "{}")
                        output = await function.ainvoke(arguments) if function else "未授权的工具"
                    except (ValueError, TypeError, httpx.HTTPError) as exc:
                        output = f"工具不可用：{exc}"
                    messages.append({"role": "tool", "tool_call_id": call["id"], "content": str(output)})
                result = await router.complete(messages)
                for key, value in (result.get("usage") or {}).items():
                    if isinstance(value, int):
                        usage[key] = usage.get(key, 0) + value
                message = result["message"]
            content = message.get("content")
            if isinstance(content, list):
                content = "".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
            if not str(content or "").strip():
                raise ValueError("模型未返回正文")
            if assert_lease:
                await assert_lease()
            return str(content).strip(), usage, result.get("model")
        except (RuntimeError, httpx.HTTPError, ValueError):
            if attempt == 2:
                raise
            await asyncio.sleep(0.5 * (2 ** attempt))
    raise RuntimeError("节点重试次数耗尽")
