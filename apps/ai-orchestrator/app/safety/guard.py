from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Iterable

from .rules import RuleResult, run_layer1
from .llm_check import LLMResult, run_layer2


@dataclass
class SafetyReport:
    layer1: RuleResult
    layer2: LLMResult
    passed: bool
    hold: bool
    issues: list[str] = field(default_factory=list)
    checked_at: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "hold": self.hold,
            "issues": self.issues,
            "layer1": self.layer1.to_dict(),
            "layer2": self.layer2.to_dict(),
            "checkedAt": self.checked_at,
        }


async def run_safety(
    content: str,
    *,
    title: str = "",
    lore: str = "",
    router=None,
    llm_enabled: bool = False,
    deny_extra: Iterable[str] | None = None,
    deny_words: Iterable[str] | None = None,
) -> SafetyReport:
    """双层内容安全审核。

    第一层（规则）始终执行；第二层（LLM）仅在 `llm_enabled` 且路由可用时执行。
    任一层不通过即 `hold=True`，由调用方将章节挂起为人工复核，避免自动发布违规内容。
    """
    layer1 = run_layer1(content, deny_extra=deny_extra, deny_words=deny_words)
    layer2 = await run_layer2(content, router, title=title, lore=lore) if llm_enabled else \
        LLMResult(passed=True, skipped=True, issues=["LLM 安全层未开启，已跳过"])
    issues = list(layer1.issues) + list(layer2.issues)
    passed = layer1.passed and layer2.passed
    return SafetyReport(
        layer1=layer1,
        layer2=layer2,
        passed=passed,
        hold=not passed,
        issues=issues,
    )
