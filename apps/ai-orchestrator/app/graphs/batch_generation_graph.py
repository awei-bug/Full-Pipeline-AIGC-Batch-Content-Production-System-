from __future__ import annotations

from langgraph.graph import END, StateGraph

from .batch_generation_state import BatchGenerationState
from .nodes.generate_batch_image import generate_batch_image_node
from .nodes.generate_batch_video import generate_batch_video_node
from .nodes.generate_image_prompt import generate_image_prompt_node
from .nodes.generate_marketing_copy import generate_marketing_copy_node
from .nodes.generate_video_script import generate_video_script_node
from .nodes.load_product_context import load_product_context_node
from .nodes.persist_batch_result import persist_batch_result_node


def selected_content_types(state: BatchGenerationState) -> set[str]:
    raw = state.get("job_item", {}).get("contentTypes") or []
    return {str(item).strip() for item in raw if str(item).strip()}


def wants_any(selected: set[str], *content_types: str) -> bool:
    if not selected:
        return True
    return any(item in selected for item in content_types)


def build_batch_generation_graph(provider):
    async def generate_marketing_copy(state: BatchGenerationState) -> BatchGenerationState:
        selected = selected_content_types(state)
        # Copy is required for selected copy itself, and as context for later stages.
        if not wants_any(
            selected,
            "marketing_copy",
            "video_script",
            "image_prompt",
            "image_asset",
            "video_asset",
        ):
            return state
        return await generate_marketing_copy_node(state, provider)

    async def generate_video_script(state: BatchGenerationState) -> BatchGenerationState:
        selected = selected_content_types(state)
        if not wants_any(selected, "video_script", "image_prompt", "image_asset", "video_asset"):
            return state
        return await generate_video_script_node(state, provider)

    async def generate_image_prompt(state: BatchGenerationState) -> BatchGenerationState:
        selected = selected_content_types(state)
        if not wants_any(selected, "image_prompt", "image_asset"):
            return state
        return await generate_image_prompt_node(state, provider)

    async def generate_batch_image(state: BatchGenerationState) -> BatchGenerationState:
        selected = selected_content_types(state)
        if not wants_any(selected, "image_prompt", "image_asset"):
            return state
        return await generate_batch_image_node(state, provider)

    async def generate_batch_video(state: BatchGenerationState) -> BatchGenerationState:
        selected = selected_content_types(state)
        if not wants_any(selected, "video_asset"):
            return state
        return await generate_batch_video_node(state, provider)

    graph = StateGraph(BatchGenerationState)
    graph.add_node("load_product_context", load_product_context_node)
    graph.add_node("generate_marketing_copy", generate_marketing_copy)
    graph.add_node("generate_video_script", generate_video_script)
    graph.add_node("generate_image_prompt", generate_image_prompt)
    graph.add_node("generate_batch_image", generate_batch_image)
    graph.add_node("generate_batch_video", generate_batch_video)
    graph.add_node("persist_batch_result", persist_batch_result_node)

    graph.set_entry_point("load_product_context")
    graph.add_edge("load_product_context", "generate_marketing_copy")
    graph.add_edge("generate_marketing_copy", "generate_video_script")
    graph.add_edge("generate_video_script", "generate_image_prompt")
    graph.add_edge("generate_image_prompt", "generate_batch_image")
    graph.add_edge("generate_batch_image", "generate_batch_video")
    graph.add_edge("generate_batch_video", "persist_batch_result")
    graph.add_edge("persist_batch_result", END)

    return graph.compile()
