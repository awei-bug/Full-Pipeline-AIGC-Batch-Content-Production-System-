from __future__ import annotations

from langgraph.graph import END, StateGraph

from .generation_state import GenerationGraphState
from .nodes.emit_failure_callback import emit_failure_callback_node
from .nodes.emit_success_callback import emit_success_callback_node
from .nodes.generate_image import generate_image_node
from .nodes.generate_video import generate_video_node
from .nodes.normalize_outputs import normalize_outputs_node
from .nodes.prepare_context import prepare_context_node
from .nodes.route_generation import route_generation_node
from .nodes.validate_request import validate_request_node


def build_generation_graph(_settings, provider, callback_client):
    async def generate_image(state: GenerationGraphState) -> GenerationGraphState:
        return await generate_image_node(state, provider)

    async def generate_video(state: GenerationGraphState) -> GenerationGraphState:
        return await generate_video_node(state, provider)

    async def emit_success(state: GenerationGraphState) -> GenerationGraphState:
        return await emit_success_callback_node(state, callback_client)

    async def emit_failure(state: GenerationGraphState) -> GenerationGraphState:
        return await emit_failure_callback_node(state, callback_client)

    graph = StateGraph(GenerationGraphState)

    graph.add_node("validate_request", validate_request_node)
    graph.add_node("prepare_context", prepare_context_node)
    graph.add_node("generate_image", generate_image)
    graph.add_node("generate_video", generate_video)
    graph.add_node("normalize_outputs", normalize_outputs_node)
    graph.add_node("emit_success_callback", emit_success)
    graph.add_node("emit_failure_callback", emit_failure)

    graph.set_entry_point("validate_request")
    graph.add_conditional_edges(
        "validate_request",
        lambda state: "emit_failure_callback" if state.get("error_code") else "prepare_context",
        {
            "prepare_context": "prepare_context",
            "emit_failure_callback": "emit_failure_callback",
        },
    )
    graph.add_conditional_edges(
        "prepare_context",
        route_generation_node,
        {
            "generate_image": "generate_image",
            "generate_video": "generate_video",
            "emit_failure_callback": "emit_failure_callback",
        },
    )
    graph.add_conditional_edges(
        "generate_image",
        lambda state: "emit_failure_callback" if state.get("error_code") else "normalize_outputs",
        {
            "normalize_outputs": "normalize_outputs",
            "emit_failure_callback": "emit_failure_callback",
        },
    )
    graph.add_conditional_edges(
        "generate_video",
        lambda state: "emit_failure_callback" if state.get("error_code") else "normalize_outputs",
        {
            "normalize_outputs": "normalize_outputs",
            "emit_failure_callback": "emit_failure_callback",
        },
    )
    graph.add_edge("normalize_outputs", "emit_success_callback")
    graph.add_edge("emit_success_callback", END)
    graph.add_edge("emit_failure_callback", END)

    return graph.compile()
