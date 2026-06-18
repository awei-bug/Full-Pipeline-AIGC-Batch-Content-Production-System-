from __future__ import annotations

from ..batch_generation_state import BatchGenerationState


async def persist_batch_result_node(state: BatchGenerationState) -> BatchGenerationState:
    outputs = []

    if state.get("copy"):
      outputs.append(
          {
              "outputType": "marketing_copy",
              "outputData": state["copy"],
          }
      )

    if state.get("script"):
      outputs.append(
          {
              "outputType": "video_script",
              "outputData": state["script"],
          }
      )

    if state.get("image_prompt"):
      outputs.append(
          {
              "outputType": "image_prompt",
              "outputData": state["image_prompt"],
          }
      )

    outputs.extend(state.get("outputs", []))
    state["outputs"] = outputs
    state["status"] = "success"
    return state
