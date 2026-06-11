from __future__ import annotations

import unittest

from app.config import Settings
from app.graphs.generation_graph import build_generation_graph
from app.graphs.generation_state import (
    build_initial_generation_state,
    is_generation_request_valid,
)
from app.models import GeneratedOutput, WorkflowRequest, WorkflowResult


class GenerationGraphStateTests(unittest.TestCase):
    def test_build_initial_generation_state_sets_expected_defaults(self):
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a poster for a launch event.",
            requestType="text_to_image",
        )

        state = build_initial_generation_state("wf_001", payload)

        self.assertEqual(state["workflow_task_id"], "wf_001")
        self.assertEqual(state["workflow_type"], "text_to_image")
        self.assertEqual(state["provider_code"], "modelscope")
        self.assertIs(state["request"], payload)
        self.assertEqual(state["current_stage"], "validate_request")
        self.assertEqual(state["progress"], 0)
        self.assertIsNone(state["result"])
        self.assertIsNone(state["error_code"])
        self.assertIsNone(state["error_message"])
        self.assertIsNone(state["failed_node"])
        self.assertEqual(state["context"], {})
        self.assertIsNone(state["external_task_id"])

    def test_is_generation_request_valid_rejects_blank_prompt(self):
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="   ",
            requestType="text_to_image",
        )
        state = build_initial_generation_state("wf_001", payload)

        self.assertFalse(is_generation_request_valid(state))

    def test_is_generation_request_valid_accepts_supported_request_types(self):
        for request_type in (
            "text_to_image",
            "image_to_image",
            "text_to_video",
            "image_to_video",
        ):
            with self.subTest(request_type=request_type):
                payload = WorkflowRequest(
                    projectId="project_001",
                    creationRequestId="cr_001",
                    taskId="task_001",
                    prompt="Generate a poster for a launch event.",
                    requestType=request_type,
                )
                state = build_initial_generation_state("wf_001", payload)

                self.assertTrue(is_generation_request_valid(state))

    def test_is_generation_request_valid_rejects_unsupported_request_type(self):
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a poster for a launch event.",
            requestType="audio_to_video",
        )
        state = build_initial_generation_state("wf_001", payload)

        self.assertFalse(is_generation_request_valid(state))

    def test_is_generation_request_valid_rejects_state_request_type_drift(self):
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a poster for a launch event.",
            requestType="text_to_image",
        )
        state = build_initial_generation_state("wf_001", payload)
        state["workflow_type"] = "text_to_video"

        self.assertFalse(is_generation_request_valid(state))


class FakeProvider:
    async def generate(self, workflow_task_id, payload, on_progress=None):
        if on_progress:
            await on_progress(60, "processing", f"external-{workflow_task_id}")
        return WorkflowResult(
            providerCode="modelscope",
            revisedPrompt="revised prompt",
            outputs=[
                GeneratedOutput(
                    assetType="image",
                    storageProvider="local",
                    objectKey="generated/test.png",
                    fileName="test.png",
                    mimeType="image/png",
                    fileSize=128,
                    width=1024,
                    height=1536,
                    metadata={"publicUrl": "/storage/assets/test.png"},
                )
            ],
        )


class FakeFailingProvider:
    async def generate(self, workflow_task_id, payload, on_progress=None):
        raise RuntimeError("provider failed")


class FakeCallbackClient:
    def __init__(self):
        self.events = []

    async def send_task_event(self, payload):
        self.events.append(payload)


class GenerationGraphExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_graph_runs_success_path_for_image_request(self):
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a poster for a launch event.",
            requestType="text_to_image",
            styleCode="cinematic",
            aspectRatio="9:16",
        )
        callback_client = FakeCallbackClient()
        graph = build_generation_graph(Settings(callback_base_url="http://127.0.0.1:3100"), FakeProvider(), callback_client)

        result = await graph.ainvoke(build_initial_generation_state("wf_001", payload))

        self.assertEqual(result["current_stage"], "completed")
        self.assertEqual(result["progress"], 100)
        self.assertEqual(result["external_task_id"], "external-wf_001")
        self.assertIsNotNone(result["result"])
        self.assertEqual(len(callback_client.events), 1)
        self.assertEqual(callback_client.events[0].status, "succeeded")

    async def test_graph_runs_failure_path_when_provider_raises(self):
        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a short trailer.",
            requestType="text_to_video",
        )
        callback_client = FakeCallbackClient()
        graph = build_generation_graph(
            Settings(callback_base_url="http://127.0.0.1:3100"),
            FakeFailingProvider(),
            callback_client,
        )

        result = await graph.ainvoke(build_initial_generation_state("wf_002", payload))

        self.assertEqual(result["current_stage"], "failed")
        self.assertEqual(result["failed_node"], "generate_video")
        self.assertEqual(result["error_code"], "ORCHESTRATOR_FAILED")
        self.assertEqual(len(callback_client.events), 1)
        self.assertEqual(callback_client.events[0].status, "failed")

    async def test_graph_failure_callback_includes_external_task_id(self):
        class ProviderWithExternalFailure:
            async def generate(self, workflow_task_id, payload, on_progress=None):
                if on_progress:
                    await on_progress(42, "submitted", "external-video-001")
                raise RuntimeError("provider timeout")

        payload = WorkflowRequest(
            projectId="project_001",
            creationRequestId="cr_001",
            taskId="task_001",
            prompt="Generate a short trailer.",
            requestType="text_to_video",
        )
        callback_client = FakeCallbackClient()
        graph = build_generation_graph(
            Settings(callback_base_url="http://127.0.0.1:3100"),
            ProviderWithExternalFailure(),
            callback_client,
        )

        await graph.ainvoke(build_initial_generation_state("wf_003", payload))

        self.assertEqual(callback_client.events[0].external_task_id, "external-video-001")


if __name__ == "__main__":
    unittest.main()
