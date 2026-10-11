from __future__ import annotations

from .modelscope_text import ModelScopeTextProvider


class AgnesTextProvider(ModelScopeTextProvider):
    async def chat(self, messages: list[dict[str, str]]) -> dict[str, object]:
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
        if not self._settings.agnes_api_key:
            raise RuntimeError("AGNES_API_KEY 未配置。")

        async with self._client(
            timeout=self._settings.create_timeout_sec,
            token=self._settings.agnes_api_key,
            base_url=self._settings.agnes_base_url,
            trust_env=self._settings.agnes_trust_env,
        ) as client:
            response = await client.post(
                "/chat/completions",
                json={
                    "model": self._settings.agnes_text_model,
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
            raise RuntimeError(str(message or f"Agnes 对话请求失败，状态码 {response.status_code}"))

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
            raise RuntimeError("Agnes 对话没有返回内容。")

        return {
            "content": content,
            "model": self._settings.agnes_text_model,
            "provider": "agnes",
        }

    async def _request_json(self, prompt: str) -> dict[str, object]:
        if not self._settings.agnes_api_key:
            return {"_meta": {"reason": "missing_api_token"}}

        async with self._client(
            timeout=self._settings.create_timeout_sec,
            token=self._settings.agnes_api_key,
            base_url=self._settings.agnes_base_url,
            trust_env=self._settings.agnes_trust_env,
        ) as client:
            response = await client.post(
                "/chat/completions",
                json={
                    "model": self._settings.agnes_text_model,
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
        content = (
            payload.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        return self._parse_json_content(content)

    def _with_generation_meta(
        self,
        payload: dict[str, object],
        *,
        fallback_used: bool,
        reason: str | None = None,
    ) -> dict[str, object]:
        result = dict(payload)
        result["generationMeta"] = {
            "source": "fallback" if fallback_used else "agnes_text",
            "fallbackUsed": fallback_used,
            "reason": reason,
            "model": self._settings.agnes_text_model,
        }
        return result
