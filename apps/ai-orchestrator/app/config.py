from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, ConfigDict


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True)

    service_name: str = "ai-orchestrator"
    text_provider: str = "modelscope"
    image_provider: str = "modelscope"
    modelscope_api_token: str | None = None
    modelscope_base_url: str = "https://api-inference.modelscope.cn/v1"
    modelscope_image_model: str = "Qwen/Qwen-Image"
    modelscope_text_model: str = "Qwen/Qwen2.5-7B-Instruct"
    modelscope_video_model: str = "Wan-AI/Wan2.1-T2V-1.3B"
    modelscope_data_inspection: str | None = '{"input":false,"output":false}'
    agnes_api_key: str | None = None
    agnes_base_url: str = "https://apihub.agnes-ai.com/v1"
    agnes_text_model: str = "agnes-2.0-flash"
    agnes_image_model: str = "agnes-image-2.1-flash"
    agnes_video_model: str = "agnes-video-v2.0"
    openai_api_key: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    openai_video_model: str = "sora-2"
    video_provider: str = "modelscope"
    callback_base_url: str | None = None
    assets_dir: Path = Path("storage/generated")
    create_timeout_sec: float = 30.0
    poll_timeout_sec: float = 30.0
    download_timeout_sec: float = 300.0
    image_poll_interval_sec: float = 2.0
    video_poll_interval_sec: float = 5.0
    image_max_attempts: int = 60
    video_max_attempts: int = 360

    @classmethod
    def from_env(cls) -> "Settings":
        assets_dir = Path(
            os.getenv(
                "AI_ORCHESTRATOR_ASSETS_DIR",
                os.getenv("LOCAL_ASSETS_DIR", "storage/generated"),
            )
        )
        agnes_api_key = os.getenv("AGNES_API_KEY")
        openai_api_key = os.getenv("OPENAI_API_KEY")
        text_provider = (
            os.getenv("AI_TEXT_PROVIDER")
            or os.getenv("TEXT_PROVIDER")
            or ("agnes" if agnes_api_key else "modelscope")
        )
        image_provider = (
            os.getenv("AI_IMAGE_PROVIDER")
            or os.getenv("IMAGE_PROVIDER")
            or ("agnes" if agnes_api_key else "modelscope")
        )
        video_provider = (
            os.getenv("AI_VIDEO_PROVIDER")
            or os.getenv("VIDEO_PROVIDER")
            or ("agnes" if agnes_api_key else None)
            or ("openai" if openai_api_key else "modelscope")
        )

        return cls(
            text_provider=text_provider.strip().lower(),
            image_provider=image_provider.strip().lower(),
            modelscope_api_token=os.getenv("MODELSCOPE_API_TOKEN"),
            modelscope_base_url=os.getenv(
                "MODELSCOPE_BASE_URL",
                "https://api-inference.modelscope.cn/v1",
            ).rstrip("/"),
            modelscope_image_model=os.getenv(
                "MODELSCOPE_IMAGE_MODEL",
                "Qwen/Qwen-Image",
            ),
            modelscope_text_model=os.getenv(
                "MODELSCOPE_TEXT_MODEL",
                "Qwen/Qwen2.5-7B-Instruct",
            ),
            modelscope_video_model=os.getenv(
                "MODELSCOPE_VIDEO_MODEL",
                "Wan-AI/Wan2.1-T2V-1.3B",
            ),
            modelscope_data_inspection=(
                os.getenv(
                    "MODELSCOPE_DATA_INSPECTION",
                    '{"input":false,"output":false}',
                ).strip()
                or None
            ),
            agnes_api_key=agnes_api_key,
            agnes_base_url=os.getenv(
                "AGNES_BASE_URL",
                "https://apihub.agnes-ai.com/v1",
            ).rstrip("/"),
            agnes_text_model=os.getenv("AGNES_TEXT_MODEL", "agnes-2.0-flash"),
            agnes_image_model=os.getenv(
                "AGNES_IMAGE_MODEL",
                "agnes-image-2.1-flash",
            ),
            agnes_video_model=os.getenv("AGNES_VIDEO_MODEL", "agnes-video-v2.0"),
            openai_api_key=openai_api_key,
            openai_base_url=os.getenv(
                "OPENAI_BASE_URL",
                "https://api.openai.com/v1",
            ).rstrip("/"),
            openai_video_model=os.getenv("OPENAI_VIDEO_MODEL", "sora-2"),
            video_provider=video_provider.strip().lower(),
            callback_base_url=os.getenv("API_SERVER_BASE_URL", "").rstrip("/") or None,
            assets_dir=assets_dir,
            create_timeout_sec=float(os.getenv("AI_CREATE_TIMEOUT_SEC", "30")),
            poll_timeout_sec=float(os.getenv("AI_POLL_TIMEOUT_SEC", "30")),
            download_timeout_sec=float(os.getenv("AI_DOWNLOAD_TIMEOUT_SEC", "300")),
            image_poll_interval_sec=float(
                os.getenv("AI_IMAGE_POLL_INTERVAL_SEC", "2")
            ),
            video_poll_interval_sec=float(
                os.getenv("AI_VIDEO_POLL_INTERVAL_SEC", "5")
            ),
            image_max_attempts=int(os.getenv("AI_IMAGE_MAX_ATTEMPTS", "60")),
            video_max_attempts=int(os.getenv("AI_VIDEO_MAX_ATTEMPTS", "360")),
        )
