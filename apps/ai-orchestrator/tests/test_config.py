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

    def test_default_text_model_uses_full_modelscope_model_id(self):
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings.from_env()

        self.assertEqual(settings.modelscope_text_model, "Qwen/Qwen2.5-7B-Instruct")

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

    def test_agnes_key_selects_agnes_providers_by_default(self):
        with patch.dict(
            os.environ,
            {
                "AGNES_API_KEY": "agnes-token",
            },
            clear=True,
        ):
            settings = Settings.from_env()

        self.assertEqual(settings.agnes_api_key, "agnes-token")
        self.assertEqual(settings.agnes_base_url, "https://apihub.agnes-ai.com/v1")
        self.assertEqual(settings.text_provider, "agnes")
        self.assertEqual(settings.image_provider, "agnes")
        self.assertEqual(settings.video_provider, "agnes")
        self.assertEqual(settings.agnes_text_model, "agnes-2.0-flash")
        self.assertEqual(settings.agnes_image_model, "agnes-image-2.1-flash")
        self.assertEqual(settings.agnes_video_model, "agnes-video-v2.0")

    def test_explicit_provider_env_can_override_agnes_defaults(self):
        with patch.dict(
            os.environ,
            {
                "AGNES_API_KEY": "agnes-token",
                "AI_TEXT_PROVIDER": "modelscope",
                "AI_IMAGE_PROVIDER": "modelscope",
                "AI_VIDEO_PROVIDER": "openai",
            },
            clear=True,
        ):
            settings = Settings.from_env()

        self.assertEqual(settings.text_provider, "modelscope")
        self.assertEqual(settings.image_provider, "modelscope")
        self.assertEqual(settings.video_provider, "openai")


if __name__ == "__main__":
    unittest.main()
