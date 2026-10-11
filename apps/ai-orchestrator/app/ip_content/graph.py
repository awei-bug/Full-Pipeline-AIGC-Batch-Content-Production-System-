from __future__ import annotations

import asyncio
import json
from typing import Any, TypedDict

import httpx
from langchain_core.tools import tool
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.graph import END, START, StateGraph

from .lore import search_lore


class IPState(TypedDict, total=False):
    title: str
    brief: str
    lore: str
    previous_chapters: str
    continuity_incomplete: bool
    feedback: str
    prompt_variant: str
    research: str
    draft: str
    polished: str
    review: str
    approved: bool
    usage: dict[str, int]
    model: str


PROMPTS = {
    "research": "你是数字IP世界观调研员。只提取与本章有关的设定、冲突和待核实事实；不得把搜索结果当作IP官方设定。输出简短的资料提要。",
    "draft": "你是游戏叙事编剧。严格遵守IP设定、调研和前章事实。不得把网络资料或未经确认的前章推测写成官方设定；只输出完整中文章节正文。",
    "polish": "你是叙事编辑。润色节奏、对白与用词，保持人物和世界观设定不变；只输出润色后的正文。",
    "review": "你是独立的设定一致性审核员。对照IP设定和前章事实检查成稿，冲突时优先遵守IP设定。第一行只能是 PASS 或 FAIL；第二行以'依据：'开头，写出所核对的设定或前章事实及结论。没有足够依据时必须写 FAIL。不得替作者改稿。",
}


def clip(value: str, limit: int) -> str:
    return " ".join(value.split())[:limit]


def build_graph(router, *, checkpointer=None, on_stage=None, assert_lease=None, search_key: str = ""):
    async def invoke(stage: str, state: IPState, text: str, *, with_tools=False) -> IPState:
        @tool
        def query_ip_lore(query: str) -> str:
            """Look up relevant canonical facts from the supplied IP setting library."""
            return search_lore(state["lore"], query)

        @tool
        async def web_search(query: str) -> str:
            """Search public web references; results are non-canonical and need verification."""
            if not search_key:
                return "联网搜索未配置；仅使用提供的IP设定，不推断外部事实。"
            async with httpx.AsyncClient(timeout=12) as client:
                response = await client.get("https://api.search.brave.com/res/v1/web/search",
                                            params={"q": query, "count": 3},
                                            headers={"X-Subscription-Token": search_key})
                response.raise_for_status()
                results = response.json().get("web", {}).get("results", [])
                return clip("\n".join(f"{r.get('title')}: {r.get('description')} ({r.get('url')})" for r in results), 3000)

        if on_stage:
            await on_stage(stage)
        system = PROMPTS[stage]
        if stage == "draft":
            system += (" 先按人物动机组织场景，保持自然叙事。" if state.get("prompt_variant") == "A"
                       else " 先核对设定约束和前文连续性，再组织场景。")
        messages = [{"role": "system", "content": system}, {"role": "user", "content": text}]
        available = {"query_ip_lore": query_ip_lore, "web_search": web_search}
        definitions = [convert_to_openai_tool(t) for t in available.values()] if with_tools else None
        usage = dict(state.get("usage") or {})
        for attempt in range(3):
            try:
                result = await router.complete(messages, definitions)
                for key, value in result["usage"].items():
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
                    for key, value in result["usage"].items():
                        if isinstance(value, int):
                            usage[key] = usage.get(key, 0) + value
                    message = result["message"]
                content = message.get("content")
                if isinstance(content, list):
                    content = "".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
                if not str(content or "").strip():
                    raise ValueError("模型未返回正文")
                output = str(content).strip()
                update: IPState = {"polished" if stage == "polish" else stage: output,
                                   "usage": usage, "model": result["model"]}
                if stage == "review":
                    lines = output.splitlines()
                    valid = len(lines) >= 2 and lines[0].strip() in ("PASS", "FAIL") and lines[1].strip().startswith("依据：") and len(lines[1].strip()) > len("依据：")
                    update["approved"] = valid and lines[0].strip() == "PASS"
                    if not valid:
                        update["review"] = f"审核结论格式或依据缺失，需人工复核。原始回复：{output}"
                if assert_lease:
                    await assert_lease()
                return update
            except (RuntimeError, httpx.HTTPError, ValueError):
                if attempt == 2:
                    raise
                await asyncio.sleep(0.5 * (2 ** attempt))
        raise RuntimeError("节点重试次数耗尽")

    async def research(state: IPState) -> IPState:
        relevant = search_lore(state["lore"], state["title"] + " " + state["brief"], limit=6)
        return await invoke("research", state, f"章节：{state['title']}\n需求：{clip(state['brief'], 1800)}\nIP设定库检索：{clip(relevant, 5500)}\n前章事实：{clip(state.get('previous_chapters', ''), 9000)}", with_tools=True)

    async def draft(state: IPState) -> IPState:
        relevant = search_lore(state["lore"], state["title"] + " " + state["brief"], limit=6)
        return await invoke("draft", state, f"章节：{state['title']}\n需求：{clip(state['brief'], 1800)}\n设定：{clip(relevant, 5500)}\n前章事实：{clip(state.get('previous_chapters', ''), 9000)}\n调研：{clip(state['research'], 2200)}\n人工修改要求：{clip(state.get('feedback', ''), 1000)}")

    async def polish(state: IPState) -> IPState:
        relevant = search_lore(state["lore"], state["title"] + " " + state["brief"])
        return await invoke("polish", state, f"章节：{state['title']}\n设定摘录：{clip(relevant, 2800)}\n初稿：{clip(state['draft'], 11000)}")

    async def review(state: IPState) -> IPState:
        relevant = search_lore(state["lore"], state["title"] + " " + state["brief"], limit=8)
        return await invoke("review", state, f"章节：{state['title']}\n原始设定：{clip(relevant, 7000)}\n前章事实：{clip(state.get('previous_chapters', ''), 9000)}\n成稿：{clip(state['polished'], 11000)}")

    graph = StateGraph(IPState)
    for name, node in (("agent_research", research), ("agent_draft", draft), ("agent_polish", polish), ("agent_review", review)):
        graph.add_node(name, node)
    graph.add_edge(START, "agent_research")
    graph.add_edge("agent_research", "agent_draft")
    graph.add_edge("agent_draft", "agent_polish")
    graph.add_edge("agent_polish", "agent_review")
    graph.add_edge("agent_review", END)
    return graph.compile(checkpointer=checkpointer)
