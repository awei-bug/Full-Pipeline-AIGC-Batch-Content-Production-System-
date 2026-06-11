from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from app.config import Settings


class SettingsTests(unittest.TestCase):
    def test_default_image_model_uses_full_modelscope_model_id(self):
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings.from_env()

        self.assertEqual(settings.modelscope_image_model, "Qwen/Qwen-Image")

    def test_default_video_model_uses_full_modelscope_model_id(self):
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings.from_env()

        self.assertEqual(settings.modelscope_video_model, "Wan-AI/Wan2.1-T2V-1.3B")

    def test_default_data_inspection_uses_json_config(self):
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings.from_env()

        self.assertEqual(
            settings.modelscope_data_inspection,
            '{"input":false,"output":false}',
        )

    def test_default_video_poll_budget_is_extended_for_real_video_jobs(self):
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings.from_env()

        self.assertEqual(settings.video_poll_interval_sec, 5.0)
        self.assertEqual(settings.video_max_attempts, 360)

    def test_openai_key_selects_openai_video_provider_by_default(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "openai-token"}, clear=True):
            settings = Settings.from_env()

        self.assertEqual(settings.openai_api_key, "openai-token")
        self.assertEqual(settings.video_provider, "openai")
        self.assertEqual(settings.openai_video_model, "sora-2")

    def test_video_provider_env_overrides_openai_auto_selection(self):
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "openai-token",
                "AI_VIDEO_PROVIDER": "modelscope",
            },
            clear=True,
        ):
            settings = Settings.from_env()

        self.assertEqual(settings.video_provider, "modelscope")


if __name__ == "__main__":
    unittest.main()
