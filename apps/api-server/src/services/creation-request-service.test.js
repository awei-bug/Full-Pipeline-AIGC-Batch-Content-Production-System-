import assert from "node:assert/strict";
import test from "node:test";

import { submitCreationRequest } from "./creation-request-service.js";

test("提交创作请求后写回编排任务信息", async () => {
  const repositoryCalls = [];
  const workflowRepository = {
    async createCreationRequest(input) {
      repositoryCalls.push({ type: "create", input });
      return {
        creationRequestId: "cr_001",
        taskId: "task_001",
        status: "submitted",
      };
    },
    async markTaskQueued(payload) {
      repositoryCalls.push({ type: "queued", payload });
    },
    async markTaskDispatchDeferred() {
      repositoryCalls.push({ type: "deferred" });
    },
  };

  const orchestratorClient = {
    async startGeneration(payload) {
      return {
        workflowTaskId: "wf_001",
        workflowType: payload.requestType,
        providerCode: "modelscope",
        status: "created",
        acceptedAt: "2026-06-10T12:00:00.000Z",
      };
    },
  };

  const result = await submitCreationRequest({
    workflowRepository,
    orchestratorClient,
    input: {
      projectId: "project_001",
      prompt: "为主角生成一张竖版海报",
      requestType: "text_to_image",
      styleCode: "cinematic",
      aspectRatio: "9:16",
    },
  });

  assert.equal(result.creationRequestId, "cr_001");
  assert.equal(result.taskId, "task_001");
  assert.equal(result.dispatchStatus, "queued");
  assert.deepEqual(result.workflowRun, {
    workflowTaskId: "wf_001",
    workflowType: "text_to_image",
    providerCode: "modelscope",
    status: "created",
    acceptedAt: "2026-06-10T12:00:00.000Z",
  });

  assert.deepEqual(repositoryCalls, [
    {
      type: "create",
      input: {
        projectId: "project_001",
        prompt: "为主角生成一张竖版海报",
        requestType: "text_to_image",
        styleCode: "cinematic",
        aspectRatio: "9:16",
      },
    },
    {
      type: "queued",
      payload: {
        taskId: "task_001",
        providerCode: "modelscope",
        workflowRun: {
          workflowTaskId: "wf_001",
          workflowType: "text_to_image",
          providerCode: "modelscope",
          status: "created",
          acceptedAt: "2026-06-10T12:00:00.000Z",
        },
      },
    },
  ]);
});

test("编排服务不可用时保留任务并标记为延后分发", async () => {
  const repositoryCalls = [];
  const workflowRepository = {
    async createCreationRequest() {
      return {
        creationRequestId: "cr_002",
        taskId: "task_002",
        status: "submitted",
      };
    },
    async markTaskQueued() {
      repositoryCalls.push({ type: "queued" });
    },
    async markTaskDispatchDeferred(payload) {
      repositoryCalls.push({ type: "deferred", payload });
    },
  };

  const orchestratorClient = {
    async startGeneration() {
      throw new Error("网络异常");
    },
  };

  const result = await submitCreationRequest({
    workflowRepository,
    orchestratorClient,
    input: {
      projectId: "project_002",
      prompt: "生成一段城市追逐短视频",
      requestType: "text_to_video",
      styleCode: "realistic",
      aspectRatio: "16:9",
    },
  });

  assert.equal(result.creationRequestId, "cr_002");
  assert.equal(result.taskId, "task_002");
  assert.equal(result.dispatchStatus, "deferred");
  assert.equal(result.workflowRun, null);
  assert.equal(result.dispatchMessage, "编排服务暂不可用，任务已入库，等待后续补发。");

  assert.deepEqual(repositoryCalls, [
    {
      type: "deferred",
      payload: {
        taskId: "task_002",
        reasonCode: "ORCHESTRATOR_UNAVAILABLE",
        reasonMessage: "网络异常",
      },
    },
  ]);
});
