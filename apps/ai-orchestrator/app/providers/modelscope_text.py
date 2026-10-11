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

    def _product_fields(self, product: dict[str, Any]) -> dict[str, str]:
        return {
            "name": str(product.get("name") or product.get("title") or "Export Product").strip(),
            "selling_point": str(
                product.get("sellingPoint") or product.get("price") or "Core export advantage"
            ).strip(),
            "category": str(product.get("category") or "General product").strip(),
            "audience": str(
                product.get("audience") or product.get("targetMarket") or "Overseas buyers"
            ).strip(),
            "scenario": str(
                product.get("scenario") or product.get("application") or "B2B wholesale"
            ).strip(),
            "price": str(product.get("price") or "FOB negotiable").strip(),
        }

    async def chat(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        normalized_messages = [
            {
                "role": str(message.get("role") or "user").strip(),
                "content": str(message.get("content") or "").strip(),
            }
            for message in messages
            if isinstance(message, dict) and str(message.get("content") or "").strip()
        ]
        if not normalized_messages:
            raise ValueError("对话内容不能为空。")
        if not self._settings.modelscope_api_token:
            raise RuntimeError("MODELSCOPE_API_TOKEN 未配置。")

        async with self._client(
            timeout=self._settings.create_timeout_sec,
            token=self._settings.modelscope_api_token,
            base_url=self._settings.modelscope_base_url,
        ) as client:
            response = await client.post(
                "/chat/completions",
                json={
                    "model": self._settings.modelscope_text_model,
                    "messages": normalized_messages,
                    "temperature": 0.7,
                },
            )

        if response.status_code >= 400:
            try:
                payload = response.json()
                message = payload.get("message") or payload.get("detail")
                if not message and isinstance(payload.get("error"), dict):
                    message = payload["error"].get("message")
            except ValueError:
                message = None
            raise RuntimeError(
                str(message or f"ModelScope 对话请求失败，状态码 {response.status_code}")
            )

        payload = response.json()
        content = (
            payload.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        if isinstance(content, list):
            content = "".join(
                str(item.get("text") or "") if isinstance(item, dict) else str(item)
                for item in content
            )
        content = str(content or "").strip()
        if not content:
            raise RuntimeError("ModelScope 对话没有返回内容。")

        return {
            "content": content,
            "model": self._settings.modelscope_text_model,
            "provider": "modelscope",
        }

    async def generate_copy(self, product: dict[str, Any]) -> dict[str, Any]:
        fields = self._product_fields(product)
        prompt = (
            "You are an export sales content assistant for Chinese factories.\n"
            "Based on the product data, write English listing content for Alibaba / website / catalog.\n"
            "Return strict JSON only, no explanation.\n"
            'JSON schema: {"title":"string","sellingPoints":["string"],"body":"string"}\n'
            "Requirements: professional B2B tone, clear benefits, export-friendly wording.\n"
            f"Product name: {fields['name']}\n"
            f"Key selling point: {fields['selling_point']}\n"
            f"Category: {fields['category']}\n"
            f"Target market: {fields['audience']}\n"
            f"Application scenario: {fields['scenario']}\n"
            f"Price note: {fields['price']}"
        )
        result = await self._request_json(prompt)
        if self._has_keys(result, "title", "sellingPoints", "body"):
            return self._with_generation_meta(result, fallback_used=False)

        return self._with_generation_meta(
            {
                "title": f"{fields['name']} for {fields['audience']}",
                "sellingPoints": [
                    fields["selling_point"],
                    f"Suitable for {fields['scenario']}",
                    f"Category: {fields['category']}",
                ],
                "body": (
                    f"{fields['name']} is designed for overseas buyers in {fields['audience']}. "
                    f"Key advantage: {fields['selling_point']}. "
                    f"Ideal for {fields['scenario']}. Price note: {fields['price']}."
                ),
            },
            fallback_used=True,
            reason=result.get("_meta", {}).get("reason", "invalid_json_response"),
        )

    async def generate_script(
        self,
        product: dict[str, Any],
        copy: dict[str, Any],
    ) -> dict[str, Any]:
        fields = self._product_fields(product)
        title = str(copy.get("title") or f"{fields['name']} Export Listing").strip()
        selling_points = copy.get("sellingPoints") or [fields["selling_point"]]
        first_selling_point = str(selling_points[0] or fields["selling_point"]).strip()
        prompt = (
            "You are an export cold-email and inquiry-reply assistant.\n"
            "Write a short English outreach email for overseas buyers.\n"
            "Return strict JSON only, no explanation.\n"
            'JSON schema: {"script":"string"}\n'
            "Requirements: greeting, product value, one proof point, soft CTA, professional tone.\n"
            f"Product name: {fields['name']}\n"
            f"Listing title: {title}\n"
            f"Selling points: {selling_points}\n"
            f"Target market: {fields['audience']}\n"
            f"Scenario: {fields['scenario']}"
        )
        result = await self._request_json(prompt)
        if self._has_keys(result, "script"):
            return self._with_generation_meta(result, fallback_used=False)

        return self._with_generation_meta(
            {
                "script": (
                    f"Dear Buyer,\n\n"
                    f"We supply {fields['name']} for {fields['audience']}. "
                    f"Key advantage: {first_selling_point}. "
                    f"It fits {fields['scenario']} use cases. "
                    f"If you are sourcing now, I can send MOQ, lead time and FOB details.\n\n"
                    f"Best regards"
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
        fields = self._product_fields(product)
        title = str(copy.get("title") or f"{fields['name']} Export Listing").strip()
        script_text = str(script.get("script") or "").strip()
        prompt = (
            "You are a product visual prompt assistant for export catalogs.\n"
            "Write one English image prompt for a clean B2B product poster / main image.\n"
            "Return strict JSON only, no explanation.\n"
            'JSON schema: {"prompt":"string"}\n'
            f"Product name: {fields['name']}\n"
            f"Listing title: {title}\n"
            f"Email summary: {script_text}"
        )
        result = await self._request_json(prompt)
        if self._has_keys(result, "prompt"):
            return self._with_generation_meta(result, fallback_used=False)

        return self._with_generation_meta(
            {
                "prompt": (
                    f"Professional export product poster of {fields['name']}, clean studio lighting, "
                    f"highlight {title}, commercial B2B style, high detail, white background"
                ),
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
                            "content": "Return strict JSON only. No markdown. No explanation.",
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
        trust_env: bool = True,
    ) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            transport=self._transport,
            trust_env=trust_env,
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
