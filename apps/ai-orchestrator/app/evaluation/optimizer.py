from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from .score import EvalReport
from ..agents.prompts import AGENT_SYSTEM_PROMPTS

logger = logging.getLogger(__name__)

ENGINEER_SYSTEM = (
    "你是提示词优化工程师，服务于一个多智能体内容生成系统。"
    "系统由四个角色组成：researcher（世界观调研员）、writer（编剧）、editor（叙事编辑）、"
    "critic（设定一致性审核员）。你会拿到当前各角色的 system 提示词，以及上一轮成稿的评测报告"
    "（评分、各维度指标、改进建议）。请输出一个 JSON 对象，键为四个角色名，值为改写后的 system 提示词字符串；"
    "只做最小必要改动，针对性地修复评测暴露的弱点（例如设定扎根不足就加强引用约束，约束未遵守就强化硬约束）。"
    "保持各角色职责边界，不要替作者改稿、不要编造设定。只输出 JSON。"
)

_PROFILE_KEY = "promptProfile:{project_id}"


class PromptOptimizer:
    """提示词自优化闭环的优化器。

    当某章节评测未通过且属于某个设定库（project_id）时，用 LLM 基于评测报告改写
    四个角色的 system 提示词，并把结果持久化为 promptProfile，供后续同库章节复用。
    无 project_id 或未开启时不触发，避免对一次性任务做无意义优化。
    """

    def __init__(self, router, store, *, enabled: bool = False, max_history: int = 5):
        self.router = router
        self.store = store
        self.enabled = enabled
        self.max_history = max_history

    async def load_overrides(self, project_id: str | None) -> dict[str, str] | None:
        if not project_id:
            return None
        profile = await self.store.get(_PROFILE_KEY.format(project_id=project_id))
        return (profile or {}).get("overrides") if profile else None

    async def maybe_optimize(
        self,
        project_id: str | None,
        eval_report: EvalReport,
        *,
        lore: str = "",
        title: str = "",
    ) -> dict[str, str] | None:
        if not self.enabled or not project_id or eval_report.passed:
            return None
        try:
            overrides = await self._optimize(project_id, eval_report, lore=lore, title=title)
        except Exception as exc:  # 优化失败不应中断主链路。
            logger.warning("提示词自优化失败，跳过：%s", exc)
            return None
        if overrides:
            await self._persist(project_id, overrides, eval_report)
        return overrides

    async def _optimize(
        self, project_id: str, eval_report: EvalReport, *, lore: str, title: str
    ) -> dict[str, str] | None:
        user = (
            f"章节：{title}\n\n当前角色提示词：\n"
            + "\n\n".join(f"[{role}]\n{prompt}" for role, prompt in AGENT_SYSTEM_PROMPTS.items())
            + f"\n\n评测报告：分数 {eval_report.score}（阈值 {eval_report.score} 未通过）\n"
            + "维度指标：" + "，".join(f"{k}={v}" for k, v in eval_report.metrics.items()) + "\n"
            + "改进建议：\n" + "\n".join(f"- {s}" for s in eval_report.suggestions)
            + "\n\n请只输出四角色改写后的 system 提示词 JSON。"
        )
        result = await self.router.complete(
            [{"role": "system", "content": ENGINEER_SYSTEM}, {"role": "user", "content": user}],
        )
        content = result.get("message", {}).get("content") or ""
        return _parse_overrides(content)

    async def _persist(self, project_id: str, overrides: dict[str, str], eval_report: EvalReport) -> None:
        existing = await self.store.get(_PROFILE_KEY.format(project_id=project_id)) or {"history": []}
        history = list(existing.get("history", []))[-(self.max_history - 1):]
        history.append({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "score": eval_report.score, "suggestions": eval_report.suggestions})
        profile = {
            "projectId": project_id,
            "version": int(existing.get("version", 0)) + 1,
            "overrides": overrides,
            "basedOnScore": eval_report.score,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "history": history,
        }
        await self.store.set(_PROFILE_KEY.format(project_id=project_id), profile)
        logger.info("已为设定库 %s 持久化提示词优化版本 %s", project_id, profile["version"])


def _parse_overrides(content: str) -> dict[str, str] | None:
    """从 LLM 输出中稳健解析四角色覆盖提示词。"""
    match = re.search(r"\{.*\}", content, re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    overrides = {}
    for role in ("researcher", "writer", "editor", "critic"):
        value = data.get(role)
        if isinstance(value, str) and value.strip():
            overrides[role] = value.strip()
    return overrides or None
