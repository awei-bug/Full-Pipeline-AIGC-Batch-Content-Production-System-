from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

# 第一层（规则）默认违禁词：仅覆盖明显违反内容政策的类别，避免对虚构剧情误伤。
DEFAULT_DENY_WORDS = (
    "代写论文", "赌博平台", "办证刻章", "枪支弹药", "毒品交易",
)

_INJECTION_PATTERNS = (
    re.compile(r"(忽略|无视|忘掉|disregard|ignore|forget).{0,30}(之前|先前|上面|前文|previous|above|instructions|指令)", re.IGNORECASE),
    re.compile(r"(你现在是|你现在是|assume you are|system\s*:)", re.IGNORECASE),
    re.compile(r"忽略(所有|全部)?(之前|先前)?(的)?(设定|规则|约束|instruction)"),
)
_PII_PATTERNS = (
    re.compile(r"1[3-9]\d{9}"),                       # 手机号
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),          # 邮箱
    re.compile(r"\d{17}[\dXx]"),                      # 身份证号
)


@dataclass
class RuleResult:
    passed: bool
    issues: list[str] = field(default_factory=list)
    checked: int = 0

    def to_dict(self) -> dict:
        return {"passed": self.passed, "issues": self.issues, "checked": self.checked}


def run_layer1(
    content: str,
    *,
    deny_extra: Iterable[str] | None = None,
    deny_words: Iterable[str] | None = None,
) -> RuleResult:
    """第一层安全审核：纯规则、确定性、零延迟。

    覆盖四类风险：提示注入、个人隐私（PII）、违禁词、空/异常内容。
    任一命中即判定不通过，并给出可读的命中原因，供人工复核定位。
    """
    issues: list[str] = []
    text = content or ""
    checked = 0

    if not text.strip():
        return RuleResult(passed=False, issues=["成稿为空或仅含空白"], checked=1)

    checked += 1
    for pattern in _INJECTION_PATTERNS:
        if pattern.search(text):
            issues.append("检测到疑似提示注入片段")
            break

    checked += 1
    for pattern in _PII_PATTERNS:
        hit = pattern.search(text)
        if hit:
            issues.append(f"检测到疑似个人敏感信息（{hit.group(0)[:3]}***）")
            break

    checked += 1
    deny = set(DEFAULT_DENY_WORDS) | set(deny_words or ()) | set(deny_extra or ())
    for word in deny:
        if word and word in text:
            issues.append(f"命中违禁词：{word}")
            break

    return RuleResult(passed=not issues, issues=issues, checked=checked)
