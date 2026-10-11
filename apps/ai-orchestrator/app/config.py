from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import BaseModel, ConfigDict


def _load_cost_pricing() -> dict | None:
    raw = os.getenv("COST_PRICING_JSON", "").strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        return None


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
    agnes_text_model: str = "agnes-2.5-flash"
    agnes_image_model: str = "agnes-image-2.5-flash"
    agnes_video_model: str = "agnes-video-v2.0"
    # Agnes 请求默认不读取系统代理，避免失效的 HTTP_PROXY/HTTPS_PROXY
    # 让本地对话请求直接失败。需要代理时可设置 AGNES_TRUST_ENV=true。
    agnes_trust_env: bool = False
    openai_api_key: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    openai_video_model: str = "sora-2"
    video_provider: str = "modelscope"
    callback_base_url: str | None = None
    internal_callback_token: str | None = None
    assets_dir: Path = Path("storage/generated")
    create_timeout_sec: float = 30.0
    callback_max_attempts: int = 3
    callback_backoff_sec: float = 1.0
    poll_timeout_sec: float = 30.0
    download_timeout_sec: float = 300.0
    image_poll_interval_sec: float = 2.0
    video_poll_interval_sec: float = 5.0
    image_max_attempts: int = 60
    video_max_attempts: int = 360

    # 对象存储（生产级持久化）
    object_store_backend: str = "local"
    object_store_local_dir: Path = Path("storage/generated")
    object_store_bucket: str | None = None
    object_store_prefix: str = ""
    object_store_endpoint: str | None = None
    # 任务队列后端：redis（配 Redis 时）/ memory（单机）
    queue_backend: str = "memory"
    # 评测与提示词自优化闭环
    eval_enabled: bool = True
    eval_threshold: float = 0.7
    prompt_opt_enabled: bool = False
    # 内容安全双层审核
    safety_llm_enabled: bool = False
    safety_deny_words: list[str] = []
    # 成本核算单价覆盖（JSON）
    cost_pricing: dict | None = None

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

        def env_bool(name: str, default: bool) -> bool:
            value = os.getenv(name)
            if value is None:
                return default
            return value.strip().lower() in {"1", "true", "yes", "on"}

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
            agnes_text_model=os.getenv("AGNES_TEXT_MODEL", "agnes-2.5-flash"),
            agnes_image_model=os.getenv(
                "AGNES_IMAGE_MODEL",
                "agnes-image-2.5-flash",
            ),
            agnes_video_model=os.getenv("AGNES_VIDEO_MODEL", "agnes-video-v2.0"),
            agnes_trust_env=env_bool("AGNES_TRUST_ENV", False),
            openai_api_key=openai_api_key,
            openai_base_url=os.getenv(
                "OPENAI_BASE_URL",
                "https://api.openai.com/v1",
            ).rstrip("/"),
            openai_video_model=os.getenv("OPENAI_VIDEO_MODEL", "sora-2"),
            video_provider=video_provider.strip().lower(),
            callback_base_url=os.getenv("API_SERVER_BASE_URL", "").rstrip("/") or None,
            internal_callback_token=(
                os.getenv("INTERNAL_CALLBACK_TOKEN", "").strip() or None
            ),
            assets_dir=assets_dir,
            create_timeout_sec=float(os.getenv("AI_CREATE_TIMEOUT_SEC", "30")),
            callback_max_attempts=max(
                1, int(os.getenv("AI_CALLBACK_MAX_ATTEMPTS", "3"))
            ),
            callback_backoff_sec=max(
                0.0, float(os.getenv("AI_CALLBACK_BACKOFF_SEC", "1"))
            ),
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
            object_store_backend=os.getenv("OBJECT_STORE_BACKEND", "local").strip().lower(),
            object_store_local_dir=Path(
                os.getenv("OBJECT_STORE_LOCAL_DIR", os.getenv("LOCAL_ASSETS_DIR", "storage/generated"))
            ),
            object_store_bucket=os.getenv("OBJECT_STORE_BUCKET", "").strip() or None,
            object_store_prefix=os.getenv("OBJECT_STORE_PREFIX", "").strip(),
            object_store_endpoint=os.getenv("OBJECT_STORE_ENDPOINT", "").strip() or None,
            queue_backend=os.getenv("QUEUE_BACKEND", "redis" if os.getenv("IP_REDIS_URL") else "memory").strip().lower(),
            eval_enabled=env_bool("EVAL_ENABLED", True),
            eval_threshold=float(os.getenv("EVAL_THRESHOLD", "0.7")),
            prompt_opt_enabled=env_bool("PROMPT_OPT_ENABLED", False),
            safety_llm_enabled=env_bool("SAFETY_LLM_ENABLED", False),
            safety_deny_words=[w.strip() for w in os.getenv("SAFETY_DENY_WORDS", "").split(",") if w.strip()],
            cost_pricing=_load_cost_pricing(),
        )
