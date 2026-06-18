from __future__ import annotations

from langgraph.graph import END, StateGraph

from .batch_generation_state import BatchGenerationState
from .nodes.generate_batch_image import generate_batch_image_node
from .nodes.generate_image_prompt import generate_image_prompt_node
from .nodes.generate_marketing_copy import generate_marketing_copy_node
from .nodes.generate_video_script import generate_video_script_node
from .nodes.load_product_context import load_product_context_node
from .nodes.persist_batch_result import persist_batch_result_node


def build_batch_generation_graph(provider):
    async def generate_marketing_copy(state: BatchGenerationState) -> BatchGenerationState:
        return await generate_marketing_copy_node(state, provider)

    async def generate_video_script(state: BatchGenerationState) -> BatchGenerationState:
        return await generate_video_script_node(state, provider)

    async def generate_image_prompt(state: BatchGenerationState) -> BatchGenerationState:
        return await generate_image_prompt_node(state, provider)

    async def generate_batch_image(state: BatchGenerationState) -> BatchGenerationState:
        return await generate_batch_image_node(state, provider)

    graph = StateGraph(BatchGenerationState)
    graph.add_node("load_product_context", load_product_context_node)
    graph.add_node("generate_marketing_copy", generate_marketing_copy)
    graph.add_node("generate_video_script", generate_video_script)
    graph.add_node("generate_image_prompt", generate_image_prompt)
    graph.add_node("generate_batch_image", generate_batch_image)
    graph.add_node("persist_batch_result", persist_batch_result_node)

    graph.set_entry_point("load_product_context")
    graph.add_edge("load_product_context", "generate_marketing_copy")
    graph.add_edge("generate_marketing_copy", "generate_video_script")
    graph.add_edge("generate_video_script", "generate_image_prompt")
    graph.add_edge("generate_image_prompt", "generate_batch_image")
    graph.add_edge("generate_batch_image", "persist_batch_result")
    graph.add_edge("persist_batch_result", END)

    return graph.compile()
