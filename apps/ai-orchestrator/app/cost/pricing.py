from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any

# 单价表：按模型名子串匹配，单位 元/千 token。数值为示例价，可用环境变量覆盖。
# 文本生成按 token 计费；图像/视频模型另有计费口径，这里仅覆盖文本链路成本。
DEFAULT_PRICING: dict[str, tuple[float, float]] = {
    "agnes-2.5": (0.004, 0.012),
    "agnes": (0.004, 0.012),
    "Qwen/Qwen2.5-7B-Instruct": (0.001, 0.001),
    "Qwen": (0.001, 0.001),
    "modelscope": (0.001, 0.001),
    "gpt-4": (0.03, 0.09),
    "gpt-3.5": (0.005, 0.015),
    "sora": (0.03, 0.09),
    "openai": (0.03, 0.09),
}

CURRENCY = "CNY"


def _load_pricing() -> dict[str, tuple[float, float]]:
    pricing = dict(DEFAULT_PRICING)
    raw = os.getenv("COST_PRICING_JSON", "").strip()
    if raw:
        try:
            overrides = json.loads(raw)
            for model, pair in overrides.items():
                if isinstance(pair, (list, tuple)) and len(pair) == 2:
                    pricing[model] = (float(pair[0]), float(pair[1]))
        except json.JSONDecodeError:
            pass
    return pricing


@dataclass
class CostBreakdown:
    input_tokens: int
    output_tokens: int
    input_cost: float
    output_cost: float
    total_cost: float
    currency: str = CURRENCY
    model: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "inputCost": round(self.input_cost, 6),
            "outputCost": round(self.output_cost, 6),
            "totalCost": round(self.total_cost, 6),
            "currency": self.currency,
            "model": self.model,
        }


def _match_rate(model: str, pricing: dict[str, tuple[float, float]]) -> tuple[float, float]:
    for key, rate in pricing.items():
        if key and key in (model or ""):
            return rate
    return (0.0, 0.0)  # 未知模型：记零成本，避免估算失真。


def compute_cost(usage: dict[str, int] | None, model: str = "",
                 pricing: dict[str, tuple[float, float]] | None = None) -> CostBreakdown:
    """根据 token 用量与模型单价计算单章节文本生成成本（人民币）。

    usage 可含 prompt_tokens / completion_tokens / total_tokens。若仅 total_tokens，
    按 1:1 近似拆分输入/输出；未知模型记零成本。
    """
    usage = usage or {}
    pricing = pricing or _load_pricing()
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    total = int(usage.get("total_tokens") or 0)
    if not prompt and not completion and total:
        prompt = total // 2
        completion = total - prompt
    in_rate, out_rate = _match_rate(model, pricing)
    input_cost = prompt / 1000 * in_rate
    output_cost = completion / 1000 * out_rate
    return CostBreakdown(
        input_tokens=prompt,
        output_tokens=completion,
        input_cost=input_cost,
        output_cost=output_cost,
        total_cost=input_cost + output_cost,
        model=model,
    )


def summarize_costs(items: list[dict[str, Any]]) -> dict[str, Any]:
    """聚合批次内各章节成本，输出总成本与按模型拆分。"""
    total = 0.0
    by_model: dict[str, float] = {}
    counted = 0
    for item in items:
        cost = (item.get("result") or {}).get("cost")
        if not isinstance(cost, dict):
            continue
        counted += 1
        tc = float(cost.get("totalCost") or 0)
        total += tc
        model = cost.get("model") or "unknown"
        by_model[model] = by_model.get(model, 0.0) + tc
    return {
        "totalCost": round(total, 6),
        "currency": CURRENCY,
        "chaptersCounted": counted,
        "byModel": {m: round(v, 6) for m, v in by_model.items()},
    }
