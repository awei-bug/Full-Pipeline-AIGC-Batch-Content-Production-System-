from __future__ import annotations

from ..batch_generation_state import BatchGenerationState


def _selected_content_types(state: BatchGenerationState) -> set[str]:
    raw = state.get("job_item", {}).get("contentTypes") or []
    return {str(item).strip() for item in raw if str(item).strip()}


def _include_output(selected: set[str], output_type: str) -> bool:
    if not selected:
        return True
    if output_type == "image_asset":
        return "image_asset" in selected or "image_prompt" in selected
    return output_type in selected


async def persist_batch_result_node(state: BatchGenerationState) -> BatchGenerationState:
    selected = _selected_content_types(state)
    outputs = []

    if state.get("copy") and _include_output(selected, "marketing_copy"):
        outputs.append(
            {
                "outputType": "marketing_copy",
                "outputData": state["copy"],
            }
        )

    if state.get("script") and _include_output(selected, "video_script"):
        outputs.append(
            {
                "outputType": "video_script",
                "outputData": state["script"],
            }
        )

    if state.get("image_prompt") and _include_output(selected, "image_prompt"):
        outputs.append(
            {
                "outputType": "image_prompt",
                "outputData": state["image_prompt"],
            }
        )

    for output in state.get("outputs", []):
        output_type = str(output.get("outputType") or "").strip()
        if output_type and _include_output(selected, output_type):
            outputs.append(output)

    state["outputs"] = outputs
    state["status"] = "success"
    return state
