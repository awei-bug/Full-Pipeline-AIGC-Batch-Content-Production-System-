from __future__ import annotations

from ..generation_state import GenerationGraphState


def route_generation_node(state: GenerationGraphState) -> str:
    workflow_type = state["workflow_type"]
    if workflow_type in {"text_to_image", "image_to_image"}:
        return "generate_image"
    if workflow_type in {"text_to_video", "image_to_video"}:
        return "generate_video"
    return "emit_failure_callback"
