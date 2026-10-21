from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Iterable

from ..evaluation.score import evaluate_chapter
from ._llm import call_stage, clip
from .prompts import AGENT_SYSTEM_PROMPTS
from .protocol import AgentMessage, AgentOutput, AgentRole, append_one, append_unique

CONSTRAINT_HINTS = ("不能", "必须", "不得", "禁止", "规则", "约束", "只允许", "不可")


class BaseAgent(ABC):
    def __init__(self, router, role: AgentRole, system: str, *, enabled_tools: Iterable[str] = (),
                 search_key: str = "", on_stage=None, assert_lease=None, max_revisions: int = 3):
        self.router = router
        self.role = role
        self.system = system
        self.enabled_tools = tuple(enabled_tools)
        self.search_key = search_key
        self.on_stage = on_stage
        self.assert_lease = assert_lease
        self.max_revisions = max_revisions

    @abstractmethod
    async def act(self, state: dict, memory) -> AgentOutput:
        ...


class ResearcherAgent(BaseAgent):
    def __init__(self, router, system_override=None, **kw):
        super().__init__(router, AgentRole.RESEARCHER, system_override or AGENT_SYSTEM_PROMPTS["researcher"],
                         enabled_tools=("query_ip_lore", "web_search"), **kw)

    async def act(self, state: dict, memory=None) -> AgentOutput:
        # 不再由代码预填检索结果：把 IP 设定库作为 query_ip_lore 工具交给模型
        # 自主选择调用，体现真正的 agentic 工具循环。
        lore = state.get("lore", "")
        tool_log: list[dict] = []
        text = (
            f"章节：{state['title']}\n需求：{clip(state['brief'], 1800)}\n"
            f"前章事实：{clip(state.get('previous_chapters', ''), 9000)}\n"
            f"请使用 query_ip_lore 工具检索与本章相关的 IP 设定、冲突与待核实事实"
            f"（联网资料用 web_search，但不得当作官方设定）。"
        )
        content, usage, model = await call_stage(
            self.router, self.system, text, enabled_tools=self.enabled_tools, lore=lore,
            search_key=self.search_key, base_usage=state.get("usage"),
            on_stage=self.on_stage, assert_lease=self.assert_lease, stage_name="agent_research",
            tool_log=tool_log,
        )
        constraints = list(state.get("memory_constraints") or [])
        for line in content.splitlines():
            if any(hint in line for hint in CONSTRAINT_HINTS):
                constraints = append_unique(constraints, line.strip())
        msg = AgentMessage(AgentRole.RESEARCHER, "supervisor", "research_summary", clip(content, 400))
        return AgentOutput(
            updates={"research": content, "usage": usage, "model": model, "memory_constraints": constraints},
            message=msg,
            trace={"role": "researcher", "action": "research", "tool_calls": tool_log},
        )


class WriterAgent(BaseAgent):
    def __init__(self, router, system_override=None, **kw):
        super().__init__(router, AgentRole.WRITER, system_override or AGENT_SYSTEM_PROMPTS["writer"],
                         enabled_tools=("query_ip_lore",), **kw)

    async def act(self, state: dict, memory=None) -> AgentOutput:
        lore = state.get("lore", "")
        tool_log: list[dict] = []
        variant = state.get("prompt_variant")
        system = self.system + (
            " 先按人物动机组织场景，保持自然叙事。" if variant == "A"
            else " 先核对设定约束和前文连续性，再组织场景。"
        )
        feedback = state.get("feedback")
        text = (
            f"章节：{state['title']}\n需求：{clip(state['brief'], 1800)}\n"
            f"前章事实：{clip(state.get('previous_chapters', ''), 9000)}\n调研：{clip(state.get('research', ''), 2200)}\n"
            f"需要核对世界观时调用 query_ip_lore 工具查询官方设定，确保不偏离 IP。"
        )
        if feedback:
            text += f"审核意见（必须据此修改，不得重复同类问题）：{feedback}\n"
        content, usage, model = await call_stage(
            self.router, system, text, lore=lore, search_key=self.search_key,
            enabled_tools=self.enabled_tools, base_usage=state.get("usage"),
            on_stage=self.on_stage, assert_lease=self.assert_lease, stage_name="agent_draft",
            tool_log=tool_log,
        )
        updates: dict[str, Any] = {"draft": content, "usage": usage, "model": model}
        if feedback:
            # 携带反馈改写：清空下游产物与反馈旗标，交还 supervisor 重新编排。
            updates["polished"] = None
            updates["review"] = None
            updates["approved"] = False
            updates["feedback"] = None
        msg = AgentMessage(
            AgentRole.WRITER, "editor" if not feedback else "supervisor",
            "draft", clip(content, 300),
        )
        return AgentOutput(
            updates=updates,
            message=msg,
            trace={"role": "writer", "action": "draft_rewrite" if feedback else "draft", "tool_calls": tool_log},
        )


class EditorAgent(BaseAgent):
    def __init__(self, router, system_override=None, **kw):
        super().__init__(router, AgentRole.EDITOR, system_override or AGENT_SYSTEM_PROMPTS["editor"],
                         enabled_tools=("query_ip_lore",), **kw)

    async def act(self, state: dict, memory=None) -> AgentOutput:
        lore = state.get("lore", "")
        tool_log: list[dict] = []
        text = (
            f"章节：{state['title']}\n初稿：{clip(state.get('draft', ''), 11000)}\n"
            f"需要核实时调用 query_ip_lore 工具，确保润色不偏离官方设定。"
        )
        content, usage, model = await call_stage(
            self.router, self.system, text, lore=lore, search_key=self.search_key,
            enabled_tools=self.enabled_tools, base_usage=state.get("usage"),
            on_stage=self.on_stage, assert_lease=self.assert_lease, stage_name="agent_polish",
            tool_log=tool_log,
        )
        msg = AgentMessage(AgentRole.EDITOR, "critic", "polish", clip(content, 300))
        return AgentOutput(
            updates={"polished": content, "usage": usage, "model": model},
            message=msg,
            trace={"role": "editor", "action": "polish", "tool_calls": tool_log},
        )


class CriticAgent(BaseAgent):
    def __init__(self, router, system_override=None, **kw):
        super().__init__(router, AgentRole.CRITIC, system_override or AGENT_SYSTEM_PROMPTS["critic"],
                         enabled_tools=("query_ip_lore",), **kw)

    async def act(self, state: dict, memory=None) -> AgentOutput:
        lore = state.get("lore", "")
        tool_log: list[dict] = []
        text = (
            f"章节：{state['title']}\n前章事实：{clip(state.get('previous_chapters', ''), 9000)}\n"
            f"成稿：{clip(state.get('polished', ''), 11000)}\n"
            f"审核时调用 query_ip_lore 工具核对官方设定；依据须写明核对的设定或前章事实。"
        )
        content, usage, model = await call_stage(
            self.router, self.system, text, enabled_tools=self.enabled_tools, lore=lore,
            search_key=self.search_key, base_usage=state.get("usage"),
            on_stage=self.on_stage, assert_lease=self.assert_lease, stage_name="agent_review",
            tool_log=tool_log,
        )
        # 确定性评测与 LLM 审核打通：评测指标作为 PASS/FAIL 的客观证据写入 trace，
        # 也让 critic 的反馈有结构化依据，而非纯拍脑袋。
        eval_report = evaluate_chapter(
            state.get("polished", "") or "", lore=lore,
            constraints=list(state.get("memory_constraints") or []),
        )
        lines = content.splitlines()
        valid = (
            len(lines) >= 2 and lines[0].strip() in ("PASS", "FAIL")
            and lines[1].strip().startswith("依据：") and len(lines[1].strip()) > len("依据：")
        )
        approved = valid and lines[0].strip() == "PASS"
        revision = int(state.get("revision", 0) or 0)
        issues = list(state.get("memory_issues") or [])
        updates: dict[str, Any] = {"review": content, "approved": approved, "usage": usage, "model": model}
        msg: AgentMessage | None = None
        trace_action = "review_pass"
        if not approved:
            fb = next((ln for ln in lines if ln.strip().startswith("依据：")), content)
            issues = append_one(issues, fb)
            if revision < self.max_revisions:
                updates["revision"] = revision + 1
                updates["feedback"] = fb
                trace_action = "review_fail"
                msg = AgentMessage(AgentRole.CRITIC, "writer", "review_feedback", clip(fb, 400))
            else:
                trace_action = "review_escalate"
                msg = AgentMessage(AgentRole.CRITIC, "supervisor", "escalate", clip(fb, 400))
        else:
            msg = AgentMessage(AgentRole.CRITIC, "supervisor", "review_pass", "PASS")
        updates["memory_issues"] = issues
        return AgentOutput(
            updates=updates,
            message=msg,
            trace={"role": "critic", "action": trace_action, "tool_calls": tool_log,
                   "eval": eval_report.to_dict()},
        )
