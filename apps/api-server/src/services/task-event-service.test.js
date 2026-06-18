import assert from "node:assert/strict";
import test from "node:test";

import { MemoryWorkflowRepository } from "../repositories/workflow-repository.js";
import { applyTaskEvent } from "./task-event-service.js";

test("编排成功回调后生成作品和资产记录", async () => {
  const repository = new MemoryWorkflowRepository();
  const created = await repository.createCreationRequest({
    projectId: "project_001",
    prompt: "生成一张角色海报",
    requestType: "text_to_image",
    styleCode: "cinematic",
    aspectRatio: "9:16",
  });

  await repository.markTaskQueued({
    taskId: created.taskId,
    providerCode: "modelscope",
    workflowRun: {
      workflowTaskId: "wf_001",
      workflowType: "text_to_image",
      providerCode: "modelscope",
      status: "created",
      acceptedAt: "2026-06-10T12:00:00.000Z",
    },
  });

  const result = await applyTaskEvent({
    workflowRepository: repository,
    event: {
      taskId: created.taskId,
      status: "succeeded",
      providerCode: "modelscope",
      revisedPrompt: "冷色调角色海报，压迫感，电影光影",
      outputs: [
        {
          assetType: "image",
          storageProvider: "local",
          objectKey: "generated/task_001.png",
          fileName: "task_001.png",
          mimeType: "image/png",
          fileSize: 2048,
          width: 1024,
          height: 1536,
          metadata: {
            publicUrl: "/storage/assets/task_001.png",
          },
        },
      ],
    },
  });

  assert.equal(result.task.status, "success");
  assert.equal(result.task.currentStage, "completed");
  assert.equal(result.work.status, "ready");
  assert.equal(result.work.assets.length, 1);
  assert.equal(result.work.assets[0].objectKey, "generated/task_001.png");

  const works = await repository.listWorks({ projectId: "project_001" });
  assert.equal(works.length, 1);
  assert.equal(works[0].latestVersion.status, "ready");
  assert.equal(works[0].assets[0].mimeType, "image/png");
});

test("编排失败回调后标记任务和请求失败", async () => {
  const repository = new MemoryWorkflowRepository();
  const created = await repository.createCreationRequest({
    projectId: "project_002",
    prompt: "生成一段城市追逐短视频",
    requestType: "text_to_video",
    styleCode: "realistic",
    aspectRatio: "16:9",
  });

  await repository.markTaskQueued({
    taskId: created.taskId,
    providerCode: "modelscope",
    workflowRun: {
      workflowTaskId: "wf_002",
      workflowType: "text_to_video",
      providerCode: "modelscope",
      status: "created",
      acceptedAt: "2026-06-10T12:00:00.000Z",
    },
  });

  const result = await applyTaskEvent({
    workflowRepository: repository,
    event: {
      taskId: created.taskId,
      status: "failed",
      providerCode: "modelscope",
      errorCode: "MODELSCOPE_VIDEO_FAILED",
      errorMessage: "视频生成失败",
    },
  });

  assert.equal(result.task.status, "failed");
  assert.equal(result.task.errorCode, "MODELSCOPE_VIDEO_FAILED");
  assert.equal(result.task.errorMessage, "视频生成失败");

  const task = await repository.getTaskById(created.taskId);
  assert.equal(task.status, "failed");

  const works = await repository.listWorks({ projectId: "project_002" });
  assert.equal(works.length, 0);
});

test("failed task event stores external provider task id", async () => {
  const repository = new MemoryWorkflowRepository();
  const created = await repository.createCreationRequest({
    projectId: "project_003",
    prompt: "Generate a short city video",
    requestType: "text_to_video",
    styleCode: "realistic",
    aspectRatio: "16:9",
  });

  await repository.markTaskQueued({
    taskId: created.taskId,
    providerCode: "modelscope",
    workflowRun: {
      workflowTaskId: "wf_003",
      workflowType: "text_to_video",
      providerCode: "modelscope",
      status: "created",
      acceptedAt: "2026-06-10T12:00:00.000Z",
    },
  });

  await applyTaskEvent({
    workflowRepository: repository,
    event: {
      taskId: created.taskId,
      status: "failed",
      providerCode: "modelscope",
      errorCode: "MODELSCOPE_VIDEO_FAILED",
      errorMessage: "Video task timed out",
      externalTaskId: "external-video-001",
    },
  });

  const task = await repository.getTaskById(created.taskId);
  assert.equal(task.metadata.provider.externalTaskId, "external-video-001");
});

test("failed task event sanitizes html provider error messages", async () => {
  const repository = new MemoryWorkflowRepository();
  const created = await repository.createCreationRequest({
    projectId: "project_004",
    prompt: "Generate a short city video",
    requestType: "text_to_video",
    styleCode: "realistic",
    aspectRatio: "16:9",
  });

  await repository.markTaskQueued({
    taskId: created.taskId,
    providerCode: "agnes",
    workflowRun: {
      workflowTaskId: "wf_004",
      workflowType: "text_to_video",
      providerCode: "agnes",
      status: "created",
      acceptedAt: "2026-06-10T12:00:00.000Z",
    },
  });

  const result = await applyTaskEvent({
    workflowRepository: repository,
    event: {
      taskId: created.taskId,
      status: "failed",
      providerCode: "agnes",
      errorCode: "AGNES_VIDEO_FAILED",
      errorMessage: "<!DOCTYPE html><html><body>Bad gateway</body></html>",
    },
  });

  assert.equal(result.task.errorMessage, "生成服务暂时不可用，请稍后重试。");
});
