import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.ip_content.service import IPContentService
from app.main import app


class StubRouter:
    async def complete(self, messages, tools=None, **_kwargs):
        if "审核员" in messages[0]["content"]:
            value = "FAIL\n依据：待人工确认"
        else:
            value = "正文"
        return {"message": {"content": value}, "usage": {"total_tokens": 3}, "model": "test"}


class StubVisualWorkflowService:
    def __init__(self):
        self.workflow = None

    async def submit_content_workflow(self, payload):
        self.workflow = {
            "id": "cw_ip_visual", "status": "queued", "createdAt": "2026-09-24T00:00:00Z",
            "workflowKind": payload["workflowKind"], "imageVariants": [], "videoVariants": [],
        }
        return self.workflow

    def get_content_workflow(self, workflow_id):
        return self.workflow if self.workflow and workflow_id == self.workflow["id"] else None


class IPApiTests(unittest.TestCase):
    def test_project_batch_review_revision_via_fastapi(self):
        with patch.dict(os.environ, {"IP_REDIS_URL": ""}), TestClient(app) as client:
            app.state.ip_service = IPContentService(StubRouter())
            created = client.post("/internal/ip-content/projects", json={
                "name": "星港", "lore": "小雨不能离开港口",
            })
            self.assertEqual(created.status_code, 200)
            project_id = created.json()["data"]["id"]
            self.assertEqual(len(client.get("/internal/ip-content/projects").json()["data"]), 1)
            accepted = client.post("/internal/ip-content/batches", json={
                "ipName": "星港", "projectId": project_id,
                "chapters": [{"title": "序章", "brief": "开场"}],
            })
            self.assertEqual(accepted.status_code, 202)
            batch_id = accepted.json()["data"]["id"]
            item_id = accepted.json()["data"]["items"][0]["id"]
            status = client.get(f"/internal/ip-content/batches/{batch_id}").json()["data"]
            self.assertEqual(status["status"], "needs_review")
            rejected = client.post(f"/internal/ip-content/batches/{batch_id}/items/{item_id}/review",
                                   json={"decision": "rejected", "note": "角色不得离港"})
            self.assertEqual(rejected.json()["data"]["status"], "needs_revision")
            revision = client.post(f"/internal/ip-content/batches/{batch_id}/items/{item_id}/revise")
            self.assertEqual(revision.status_code, 202)
            self.assertEqual(len(client.get(f"/internal/ip-content/batches/{batch_id}").json()["data"]["items"][0]["revisions"]), 1)

    def test_approved_chapter_starts_and_reads_visual_workflow(self):
        visual_service = StubVisualWorkflowService()
        with patch.dict(os.environ, {"IP_REDIS_URL": ""}), TestClient(app) as client:
            app.state.ip_service = IPContentService(StubRouter())
            accepted = client.post("/internal/ip-content/batches", json={
                "ipName": "星港", "lore": "小雨不能离开港口",
                "chapters": [{"title": "序章", "brief": "守望星港"}],
            }).json()["data"]
            batch_id = accepted["id"]
            item_id = accepted["items"][0]["id"]
            client.post(
                f"/internal/ip-content/batches/{batch_id}/items/{item_id}/review",
                json={"decision": "approved"},
            )
            with patch("app.main.service", visual_service):
                created = client.post(
                    f"/internal/ip-content/batches/{batch_id}/items/{item_id}/visuals",
                    json={"outputs": ["image"], "style": "cinematic"},
                )
                self.assertEqual(created.status_code, 202, created.text)
                self.assertEqual(created.json()["data"]["workflowKind"], "ip_chapter")
                status = client.get(
                    f"/internal/ip-content/batches/{batch_id}/items/{item_id}/visuals"
                )
                self.assertEqual(status.status_code, 200, status.text)
                self.assertEqual(status.json()["data"]["id"], "cw_ip_visual")


if __name__ == "__main__":
    unittest.main()
