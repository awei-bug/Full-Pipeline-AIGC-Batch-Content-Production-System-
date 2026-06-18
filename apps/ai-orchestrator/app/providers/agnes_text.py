from __future__ import annotations

from .modelscope_text import ModelScopeTextProvider


class AgnesTextProvider(ModelScopeTextProvider):
    async def _request_json(self, prompt: str) -> dict[str, object]:
        if not self._settings.agnes_api_key:
            return {"_meta": {"reason": "missing_api_token"}}

        async with self._client(
            timeout=self._settings.create_timeout_sec,
            token=self._settings.agnes_api_key,
            base_url=self._settings.agnes_base_url,
        ) as client:
            response = await client.post(
                "/chat/completions",
                json={
                    "model": self._settings.agnes_text_model,
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
