from __future__ import annotations

import json
import re
from typing import Any

import httpx

from ..config import Settings


class ModelScopeTextProvider:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._transport = transport

    async def generate_copy(self, product: dict[str, Any]) -> dict[str, Any]:
        name = str(product.get("name") or product.get("title") or "商品").strip()
        selling_point = str(
            product.get("sellingPoint") or product.get("price") or "核心卖点"
        ).strip()
        category = str(product.get("category") or "通用商品").strip()
        audience = str(product.get("audience") or "泛人群").strip()
        scenario = str(product.get("scenario") or "日常使用").strip()
        prompt = (
            "你是电商营销文案助手。\n"
            "请基于给定商品信息，输出适合商品投放的营销文案。\n"
            "必须严格返回 JSON，不要输出解释。\n"
            'JSON schema: {"title":"string","sellingPoints":["string"],"body":"string"}\n'
            f"商品名称: {name}\n"
            f"核心卖点: {selling_point}\n"
            f"商品分类: {category}\n"
            f"目标人群: {audience}\n"
            f"使用场景: {scenario}"
        )
        result = await self._request_json(prompt)
        if self._has_keys(result, "title", "sellingPoints", "body"):
            return self._with_generation_meta(result, fallback_used=False)

        return self._with_generation_meta(
            {
                "title": f"{name}营销标题",
                "sellingPoints": [selling_point],
                "body": f"{name}聚焦{selling_point}，适合{audience}在{scenario}场景快速转化。",
            },
            fallback_used=True,
            reason=result.get("_meta", {}).get("reason", "invalid_json_response"),
        )

    async def generate_script(
        self,
        product: dict[str, Any],
        copy: dict[str, Any],
    ) -> dict[str, Any]:
        name = str(product.get("name") or product.get("title") or "商品").strip()
        title = str(copy.get("title") or f"{name}营销标题").strip()
        selling_points = copy.get("sellingPoints") or [
            product.get("sellingPoint") or "核心卖点"
        ]
        first_selling_point = str(selling_points[0] or "核心卖点").strip()
        prompt = (
            "你是短视频脚本助手。\n"
            "请输出 15 到 25 秒的商品口播脚本。\n"
            "必须严格返回 JSON，不要输出解释。\n"
            'JSON schema: {"script":"string"}\n'
            f"商品名称: {name}\n"
            f"营销标题: {title}\n"
            f"卖点列表: {selling_points}"
        )
        result = await self._request_json(prompt)
        if self._has_keys(result, "script"):
            return self._with_generation_meta(result, fallback_used=False)

        return self._with_generation_meta(
            {
                "script": (
                    f"开场展示{name}，突出{title}，中段讲解"
                    f"{first_selling_point}，结尾引导立即下单。"
                ),
            },
            fallback_used=True,
            reason=result.get("_meta", {}).get("reason", "invalid_json_response"),
        )

    async def generate_image_prompt(
        self,
        product: dict[str, Any],
        copy: dict[str, Any],
        script: dict[str, Any],
    ) -> dict[str, Any]:
        name = str(product.get("name") or product.get("title") or "商品").strip()
        title = str(copy.get("title") or f"{name}营销标题").strip()
        script_text = str(script.get("script") or "").strip()
        prompt = (
            "你是商品海报提示词助手。\n"
            "请输出适合文生图模型直接使用的中文海报提示词。\n"
            "必须严格返回 JSON，不要输出解释。\n"
            'JSON schema: {"prompt":"string"}\n'
            f"商品名称: {name}\n"
            f"营销标题: {title}\n"
            f"脚本摘要: {script_text}"
        )
        result = await self._request_json(prompt)
        if self._has_keys(result, "prompt"):
            return self._with_generation_meta(result, fallback_used=False)

        return self._with_generation_meta(
            {
                "prompt": f"{name}商品海报，突出{title}，画面高级干净，结合脚本信息：{script_text}",
            },
            fallback_used=True,
            reason=result.get("_meta", {}).get("reason", "invalid_json_response"),
        )

    async def _request_json(self, prompt: str) -> dict[str, Any]:
        if not self._settings.modelscope_api_token:
            return {"_meta": {"reason": "missing_api_token"}}

        async with self._client(
            timeout=self._settings.create_timeout_sec,
            token=self._settings.modelscope_api_token,
            base_url=self._settings.modelscope_base_url,
        ) as client:
            response = await client.post(
                "/chat/completions",
                json={
                    "model": self._settings.modelscope_text_model,
                    "messages": [
                        {
                            "role": "system",
                            "content": "请严格输出 JSON，不要输出 markdown 或解释。",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.4,
                },
            )

        if response.status_code >= 400:
            return {"_meta": {"reason": f"http_{response.status_code}"}}

        payload = response.json()
        content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
        return self._parse_json_content(content)

    def _client(
        self,
        *,
        timeout: float,
        token: str,
        base_url: str,
    ) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            transport=self._transport,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )

    def _parse_json_content(self, content: Any) -> dict[str, Any]:
        if isinstance(content, dict):
            return content

        text = str(content or "").strip()
        if not text:
            return {"_meta": {"reason": "empty_response"}}

        fenced_match = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
        if fenced_match:
            text = fenced_match.group(1).strip()

        if text.startswith("{") and text.endswith("}"):
            parsed = self._try_parse_object(text)
            if parsed is not None:
                return parsed
            return {"_meta": {"reason": "invalid_json_response"}}

        object_match = re.search(r"(\{.*\})", text, re.DOTALL)
        if object_match:
            parsed = self._try_parse_object(object_match.group(1))
            if parsed is not None:
                return parsed

        return {"_meta": {"reason": "invalid_json_response"}}

    def _try_parse_object(self, raw: str) -> dict[str, Any] | None:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return None

        if isinstance(parsed, dict):
            return parsed
        return None

    def _with_generation_meta(
        self,
        payload: dict[str, Any],
        *,
        fallback_used: bool,
        reason: str | None = None,
    ) -> dict[str, Any]:
        result = dict(payload)
        result["generationMeta"] = {
            "source": "fallback" if fallback_used else "modelscope_text",
            "fallbackUsed": fallback_used,
            "reason": reason,
            "model": self._settings.modelscope_text_model,
        }
        return result

    @staticmethod
    def _has_keys(payload: dict[str, Any], *keys: str) -> bool:
        return all(key in payload for key in keys)
