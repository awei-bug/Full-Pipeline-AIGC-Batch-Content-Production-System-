from __future__ import annotations

from ..generation_state import GenerationGraphState, is_generation_request_valid


async def validate_request_node(state: GenerationGraphState) -> GenerationGraphState:
    next_state = dict(state)
    next_state["current_stage"] = "validate_request"
    next_state["progress"] = 5
    if not is_generation_request_valid(state):
        next_state["error_code"] = "INVALID_WORKFLOW_REQUEST"
        next_state["error_message"] = "Invalid workflow request."
        next_state["failed_node"] = "validate_request"
        next_state["current_stage"] = "failed"
    return next_state
