from __future__ import annotations

import unittest

from app.config import Settings
from app.providers.modelscope import build_video_extra_headers


class ModelScopeProviderTests(unittest.TestCase):
    def test_build_video_extra_headers_omits_data_inspection_when_unset(self):
        settings = Settings(
            modelscope_api_token="token",
            callback_base_url="http://127.0.0.1:3100",
            modelscope_data_inspection=None,
        )

        headers = build_video_extra_headers(settings)

        self.assertEqual(headers, {"X-ModelScope-Async-Mode": "true"})

    def test_build_video_extra_headers_includes_data_inspection_when_configured(self):
        settings = Settings(
            modelscope_api_token="token",
            callback_base_url="http://127.0.0.1:3100",
            modelscope_data_inspection='{"enabled":false}',
        )

        headers = build_video_extra_headers(settings)

        self.assertEqual(
            headers,
            {
                "X-ModelScope-Async-Mode": "true",
                "X-ModelScope-DataInspection": '{"enabled":false}',
            },
        )


if __name__ == "__main__":
    unittest.main()
