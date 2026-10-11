from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from ..ip_content.lore import search_lore

# 评测权重：设定一致性最重要，其次约束合规与可读性，长度仅作健康度参考。
WEIGHTS = {"lore_consistency": 0.4, "constraint_compliance": 0.3, "readability": 0.2, "length": 0.1}
IDEAL_MIN, IDEAL_MAX = 600, 4000  # 中文章节正文的合理长度区间（字符数）


def _split_sentences(text: str) -> list[str]:
    return [s for s in text.replace("！", "。").replace("？", "。").replace("?", "。").split("。") if s.strip()]


def length_score(content: str) -> float:
    n = len(content)
    if IDEAL_MIN <= n <= IDEAL_MAX:
        return 1.0
    if n < IDEAL_MIN:
        return max(0.0, n / IDEAL_MIN)
    return max(0.0, 1.0 - (n - IDEAL_MAX) / (IDEAL_MAX * 1.5))


def _bigrams(text: str) -> list[str]:
    compact = "".join(ch for ch in text if not ch.isspace())
    if len(compact) < 2:
        return [compact] if compact else []
    return [compact[i:i + 2] for i in range(len(compact) - 1)]


def _overlap_ratio(needle: str, haystack: str) -> float:
    """字符二元组覆盖率：衡量 needle 的关键片段在 haystack 中的出现比例。

    比整句子串匹配更稳健——能识别"角色不能离开港口"这类含否定词的约束，
    不会被"不能/必须"等虚词干扰。
    """
    grams = _bigrams(needle)
    if not grams:
        return 1.0
    return sum(1 for g in grams if g in haystack) / len(grams)


def constraint_compliance(content: str, constraints: list[str] | None) -> float:
    constraints = [c for c in (constraints or []) if c.strip()]
    if not constraints:
        return 1.0
    return sum(_overlap_ratio(c, content) for c in constraints) / len(constraints)


def lore_consistency(content: str, lore: str) -> float:
    """用设定库检索召回的相关片段，衡量成稿对官方设定的扎根程度（确定性，不调 LLM）。"""
    if not lore.strip() or not content.strip():
        return 1.0
    relevant = search_lore(lore, content[:200], limit=4)
    # search_lore 为每个片段加了"[设定片段 N] "前缀，比对前需剥离，避免前缀拉低覆盖率。
    lines = [re.sub(r"^\[设定片段\s*\d+\]\s*", "", ln).strip() for ln in relevant.splitlines()]
    lines = [ln for ln in lines if len(ln) >= 4]
    if not lines:
        return 1.0
    return sum(_overlap_ratio(ln, content) for ln in lines) / len(lines)


def readability_score(content: str) -> float:
    sentences = _split_sentences(content)
    if not sentences:
        return 0.0
    avg = sum(len(s) for s in sentences) / len(sentences)
    # 平均句长过短（碎片）或过长的单句都会降低可读性评分。
    if 12 <= avg <= 160:
        return 1.0
    if avg < 12:
        return max(0.2, avg / 12)
    return max(0.2, 1.0 - (avg - 160) / 400)


@dataclass
class EvalReport:
    score: float
    passed: bool
    metrics: dict[str, float] = field(default_factory=dict)
    suggestions: list[str] = field(default_factory=list)
    content_length: int = 0
    evaluated_at: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": round(self.score, 4),
            "passed": self.passed,
            "metrics": {k: round(v, 4) for k, v in self.metrics.items()},
            "suggestions": self.suggestions,
            "contentLength": self.content_length,
            "evaluatedAt": self.evaluated_at,
        }


def evaluate_chapter(
    content: str,
    *,
    lore: str = "",
    constraints: list[str] | None = None,
    threshold: float = 0.7,
) -> EvalReport:
    """对成稿做确定性多维评分，输出 EvalReport。

    不依赖 LLM，可在无密钥环境下运行，作为评测自优化闭环的观测与触发信号。
    """
    content = content or ""
    if not content.strip():
        return EvalReport(score=0.0, passed=False, metrics={k: 0.0 for k in WEIGHTS},
                          suggestions=["成稿为空或仅含空白"], content_length=0)
    metrics = {
        "lore_consistency": round(lore_consistency(content, lore), 4),
        "constraint_compliance": round(constraint_compliance(content, constraints), 4),
        "readability": round(readability_score(content), 4),
        "length": round(length_score(content), 4),
    }
    score = round(sum(metrics[k] * WEIGHTS[k] for k in WEIGHTS), 4)
    suggestions: list[str] = []
    if metrics["lore_consistency"] < 0.5:
        suggestions.append("成稿对设定库关键事实的扎根不足，建议强化设定引用。")
    if metrics["constraint_compliance"] < 1.0:
        suggestions.append("存在未遵守的世界观约束，需对照约束清单修订。")
    if metrics["readability"] < 0.6:
        suggestions.append("可读性偏低，建议拆分过长句子、平衡节奏。")
    if metrics["length"] < 0.5:
        suggestions.append("篇幅偏离合理区间，建议扩展到设定与情节更完整的体量。")
    return EvalReport(
        score=score,
        passed=score >= threshold,
        metrics=metrics,
        suggestions=suggestions,
        content_length=len(content),
    )
