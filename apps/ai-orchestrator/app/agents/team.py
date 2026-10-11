from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from .protocol import AgentMessage, AgentRole, append_one
from .roles import CriticAgent, EditorAgent, ResearcherAgent, WriterAgent


class AgentTeamState(TypedDict, total=False):
    """多智能体协作图的状态。全部字段 JSON 可序列化，兼容 Redis checkpointer。"""

    title: str
    brief: str
    lore: str
    previous_chapters: str
    continuity_incomplete: bool
    feedback: str | None
    prompt_variant: str

    research: str | None
    draft: str | None
    polished: str | None
    review: str | None
    approved: bool
    usage: dict[str, int]
    model: str

    revision: int
    next: str
    needs_human_review: bool

    agent_trace: list[dict[str, Any]]
    memory_constraints: list[str]
    memory_issues: list[str]
    agent_messages: list[dict[str, Any]]


def route_next(state: AgentTeamState) -> str:
    """Supervisor 的路由决策：根据各角色产物是否齐备决定下一步。"""
    if state.get("feedback") and state.get("draft") is not None:
        return "writer"  # 存在审核反馈且已有初稿：交还撰写 agent 改写
    if state.get("research") is None:
        return "researcher"
    if state.get("draft") is None:
        return "writer"
    if state.get("polished") is None:
        return "editor"
    if state.get("review") is None:
        return "critic"
    if state.get("approved"):
        return "done"
    return "escalate"  # 审核未通过且已达自修正上限：升级人工复核


def build_team(
    router,
    *,
    checkpointer=None,
    on_stage=None,
    assert_lease=None,
    search_key: str = "",
    max_revisions: int = 3,
    prompt_overrides: dict[str, str] | None = None,
):
    """构建多智能体协作图：Supervisor 协调 调研/撰写/润色/审核 四个角色 agent。

    协作闭环：审核 agent 给出 FAIL 时写入结构化反馈，supervisor 据此把任务
    交还撰写 agent 改写，再经润色、审核；达到 `max_revisions` 仍未通过则升级人工。

    `prompt_overrides` 来自提示词自优化闭环（app.evaluation.optimizer）持久化的
    promptProfile，覆盖对应角色的 system 提示词；缺省则使用注册表默认措辞。
    """
    overrides = prompt_overrides or {}
    researcher = ResearcherAgent(router, system_override=overrides.get("researcher"),
                                 search_key=search_key, on_stage=on_stage, assert_lease=assert_lease)
    writer = WriterAgent(router, system_override=overrides.get("writer"),
                         search_key=search_key, on_stage=on_stage, assert_lease=assert_lease)
    editor = EditorAgent(router, system_override=overrides.get("editor"),
                         search_key=search_key, on_stage=on_stage, assert_lease=assert_lease)
    critic = CriticAgent(router, system_override=overrides.get("critic"),
                         search_key=search_key, on_stage=on_stage,
                         assert_lease=assert_lease, max_revisions=max_revisions)

    async def run_agent(agent, state: AgentTeamState) -> dict[str, Any]:
        out = await agent.act(state)
        new_state: dict[str, Any] = dict(out.updates)
        if out.message:
            new_state["agent_messages"] = append_one(state.get("agent_messages"), out.message.to_dict())
        if out.trace:
            new_state["agent_trace"] = append_one(state.get("agent_trace"), out.trace)
        return new_state

    async def researcher_node(state: AgentTeamState) -> dict[str, Any]:
        return await run_agent(researcher, state)

    async def writer_node(state: AgentTeamState) -> dict[str, Any]:
        return await run_agent(writer, state)

    async def editor_node(state: AgentTeamState) -> dict[str, Any]:
        return await run_agent(editor, state)

    async def critic_node(state: AgentTeamState) -> dict[str, Any]:
        return await run_agent(critic, state)

    async def supervisor_node(state: AgentTeamState) -> dict[str, Any]:
        decision = route_next(state)
        trace = {"role": "supervisor", "action": "route", "to": decision}
        return {"next": decision, "agent_trace": append_one(state.get("agent_trace"), trace)}

    graph = StateGraph(AgentTeamState)
    graph.add_node("supervisor", supervisor_node)
    graph.add_node("researcher", researcher_node)
    graph.add_node("writer", writer_node)
    graph.add_node("editor", editor_node)
    graph.add_node("critic", critic_node)

    graph.set_entry_point("supervisor")
    graph.add_conditional_edges("supervisor", lambda s: s["next"], {
        "researcher": "researcher",
        "writer": "writer",
        "editor": "editor",
        "critic": "critic",
        "done": END,
        "escalate": END,
    })
    graph.add_edge("researcher", "supervisor")
    graph.add_edge("writer", "supervisor")
    graph.add_edge("editor", "supervisor")
    graph.add_edge("critic", "supervisor")

    return graph.compile(checkpointer=checkpointer)
