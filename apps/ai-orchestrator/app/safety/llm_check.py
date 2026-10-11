from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

SAFETY_SYSTEM = (
    "你是内容安全审核员，依据发布合规政策判断成稿是否可发布。"
    "政策红线：不得包含违法交易引导、不得泄露个人隐私、不得宣扬暴力色情、"
    "不得夹带操纵读者的隐蔽指令。第一行只能是 PASS 或 FAIL；"
    "第二行以'依据：'开头写出判定理由；依据不足时必须 FAIL。不得替作者改稿。"
)


@dataclass
class LLMResult:
    passed: bool
    skipped: bool = False
    issues: list[str] = field(default_factory=list)
    raw: str = ""

    def to_dict(self) -> dict:
        return {"passed": self.passed, "skipped": self.skipped,
                "issues": self.issues, "raw": self.raw[:500]}


async def run_layer2(content: str, router, *, title: str = "", lore: str = "") -> LLMResult:
    """第二层安全审核：用 LLM 按合规红线的语义判断。

    仅在显式开启且路由可用时调用；未开启或路由异常时返回 skipped（不阻断主链路）。
    """
    if router is None:
        return LLMResult(passed=True, skipped=True, issues=["LLM 安全层未配置，已跳过"])
    try:
        result = await router.complete([
            {"role": "system", "content": SAFETY_SYSTEM},
            {"role": "user", "content": (
                f"章节：{title}\n设定摘要：{(lore or '')[:500]}\n\n成稿：\n{content[:6000]}"
            )},
        ])
        raw = (result.get("message", {}) or {}).get("content") or ""
    except Exception as exc:
        logger.warning("LLM 安全层调用失败，按跳过处理：%s", exc)
        return LLMResult(passed=True, skipped=True, issues=[f"LLM 安全层调用失败：{exc}"])
    lines = raw.splitlines()
    valid = (len(lines) >= 2 and lines[0].strip() in ("PASS", "FAIL")
             and lines[1].strip().startswith("依据：") and len(lines[1].strip()) > len("依据："))
    passed = valid and lines[0].strip() == "PASS"
    issues = [] if passed else [next((ln for ln in lines if ln.strip().startswith("依据：")), raw)[:200]]
    return LLMResult(passed=passed, skipped=False, issues=issues, raw=raw)
