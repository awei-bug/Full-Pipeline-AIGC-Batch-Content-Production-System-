import crypto from "node:crypto";
import { DEMO_USER_ID } from "./store.js";
import { now, sleep } from "./media-utils.js";

export class TaskOrchestrator {
  constructor({ store, baseUrl, providers }) {
    this.store = store;
    this.baseUrl = baseUrl;
    this.providers = providers;
    this.runningTasks = new Set();
  }

  getProviderStatus() {
    return {
      image: this.providers.image.name,
      imageFallback: this.providers.imageFallback?.name || null,
      video: this.providers.video.name,
      videoFallback: this.providers.videoFallback?.name || null,
    };
  }

  #getStyleLabel(styleCode) {
    const styleMap = {
      cinematic: "电影感",
      realistic: "写实",
      cyberpunk: "赛博朋克",
      minimal: "极简",
    };

    return styleMap[styleCode] || "默认";
  }

  #getWorkTitle(task) {
    const kindMap = {
      image: "图片",
      video: "视频",
    };

    return `${this.#getStyleLabel(task.styleCode)}${kindMap[task.kind] || "作品"}`;
  }

  async recover() {
    const tasks = await this.store.listTasks();
    for (const task of tasks) {
      if (["created", "queued", "running", "post_processing", "reviewing"].includes(task.status)) {
        await this.store.updateTask(task.id, (draft) => {
          draft.status = "failed";
          draft.currentStage = "failing";
          draft.errorCode = "RECOVERY_FAILED";
          draft.errorMessage = "服务重启前任务未完成，已标记失败";
          draft.finishedAt = now();
        });

        await this.store.updateCreationRequest(task.creationRequestId, (request) => {
          request.status = "failed";
        });

        await this.store.appendTaskHistory({
          id: crypto.randomUUID(),
          taskId: task.id,
          fromStatus: task.status,
          toStatus: "failed",
          stage: "recovery",
          message: "服务恢复时将未完成任务标记为失败",
          createdAt: now(),
        });

        await this.#releaseCredits(task.requiredCredits);
      }
    }
  }

  async submitCreation(payload) {
    const user = await this.store.getDemoUser();
    const requiredCredits = payload.kind === "video" ? 40 : 10;
    if (user.credits.available < requiredCredits) {
      const error = new Error("额度不足");
      error.code = "CREDIT_INSUFFICIENT";
      throw error;
    }

    const creationRequestId = `cr_${crypto.randomUUID()}`;
    const taskId = `task_${crypto.randomUUID()}`;
    const currentTime = now();
    const selectedProvider = payload.kind === "video" ? this.providers.video.name : this.providers.image.name;

    const creationRequest = {
      id: creationRequestId,
      requestNo: creationRequestId,
      userId: DEMO_USER_ID,
      kind: payload.kind,
      prompt: payload.prompt,
      styleCode: payload.styleCode || "default",
      aspectRatio: payload.aspectRatio || "16:9",
      imageCount: payload.imageCount || 1,
      durationSec: payload.durationSec || 4,
      status: "submitted",
      taskIds: [taskId],
      workId: null,
      createdAt: currentTime,
      updatedAt: currentTime,
    };

    const task = {
      id: taskId,
      taskNo: taskId,
      creationRequestId,
      userId: DEMO_USER_ID,
      kind: payload.kind,
      prompt: payload.prompt,
      styleCode: payload.styleCode || "default",
      aspectRatio: payload.aspectRatio || "16:9",
      imageCount: payload.imageCount || 1,
      durationSec: payload.durationSec || 4,
      status: "created",
      currentStage: "request_validating",
      progress: 5,
      requiredCredits,
      provider: selectedProvider,
      revisedPrompt: null,
      errorCode: null,
      errorMessage: null,
      assetIds: [],
      workId: null,
      createdAt: currentTime,
      updatedAt: currentTime,
      startedAt: null,
      finishedAt: null,
    };

    const history = {
      id: crypto.randomUUID(),
      taskId,
      fromStatus: null,
      toStatus: "created",
      stage: "request_validating",
      message: "任务已创建",
      createdAt: currentTime,
    };

    await this.store.createCreationBundle({
      creationRequest,
      task,
      history,
    });

    await this.store.updateCredits((credits) => {
      credits.available -= requiredCredits;
      credits.frozen += requiredCredits;
    });

    this.#enqueue(taskId);

    return {
      creationRequestId,
      taskId,
      status: "submitted",
    };
  }

  async getCreationView(requestId) {
    const request = await this.store.getCreationRequestById(requestId);
    if (!request) {
      return null;
    }

    return {
      ...request,
      tasks: (await Promise.all(request.taskIds.map((taskId) => this.store.getTaskById(taskId)))).filter(Boolean),
      work: request.workId ? await this.store.getWorkById(request.workId) : null,
    };
  }

  async regenerateWork(workId, promptOverride) {
    const work = await this.store.getWorkById(workId);
    if (!work) {
      return null;
    }

    return this.submitCreation({
      kind: work.kind,
      prompt: promptOverride || work.prompt,
      styleCode: work.styleCode,
      aspectRatio: work.aspectRatio,
      durationSec: work.durationSec,
      imageCount: 1,
    });
  }

  #enqueue(taskId) {
    if (this.runningTasks.has(taskId)) {
      return;
    }

    this.runningTasks.add(taskId);
    queueMicrotask(async () => {
      try {
        await this.#process(taskId);
      } finally {
        this.runningTasks.delete(taskId);
      }
    });
  }

  async #process(taskId) {
    await sleep(250);
    await this.#transition(taskId, "queued", "dispatching", 15, "任务已进入队列");
    await sleep(300);
    await this.#transition(taskId, "running", "model_generating", 35, "开始生成");

    const task = await this.store.getTaskById(taskId);
    if (!task) {
      return;
    }

    await this.store.updateTask(taskId, (draft) => {
      draft.startedAt = draft.startedAt || now();
    });

    let generationResult;
    try {
      generationResult = task.kind === "video" ? await this.#generateVideoWithFallback(task) : await this.#generateImageWithFallback(task);
    } catch (error) {
      await this.#markFailed(taskId, "GENERATION_FAILED", error.message);
      return;
    }

    await this.#transition(
      taskId,
      "post_processing",
      task.kind === "video" ? "postprocess_transcoding" : "postprocess_upscaling",
      75,
      "开始处理生成结果",
    );
    await sleep(250);

    const storedAssets = [];
    for (const output of generationResult.outputs) {
      const asset = {
        id: `asset_${crypto.randomUUID()}`,
        type: output.type,
        kind: task.kind,
        title: output.title,
        url: `${this.baseUrl}${output.publicPath}`,
        publicPath: output.publicPath,
        fileName: output.fileName || output.publicPath.split("/").pop(),
        mimeType: output.mimeType,
        width: output.width,
        height: output.height,
        durationSec: output.durationSec ?? null,
        size: output.size,
        provider: output.provider || generationResult.provider,
        createdAt: now(),
        updatedAt: now(),
      };
      storedAssets.push(await this.store.createAsset(asset));
    }

    await this.store.updateTask(taskId, (draft) => {
      draft.assetIds = storedAssets.map((asset) => asset.id);
      draft.provider = generationResult.provider;
      draft.revisedPrompt = generationResult.revisedPrompt || null;
    });

    await this.#transition(taskId, "reviewing", "post_moderating", 90, "开始检查生成结果");
    await sleep(200);

    const request = await this.store.getCreationRequestById(task.creationRequestId);
    const work = {
      id: `work_${crypto.randomUUID()}`,
      title: this.#getWorkTitle(task),
      kind: task.kind,
      prompt: task.prompt,
      revisedPrompt: generationResult.revisedPrompt || null,
      styleCode: task.styleCode,
      aspectRatio: task.aspectRatio,
      durationSec: task.kind === "video" ? task.durationSec : null,
      status: "ready",
      provider: generationResult.provider,
      creationRequestId: task.creationRequestId,
      taskId,
      assets: storedAssets,
      createdAt: now(),
      updatedAt: now(),
      requestSummary: request ? request.requestNo : null,
    };

    await this.store.createWork(work);
    await this.store.updateTask(taskId, (draft) => {
      draft.workId = work.id;
      draft.finishedAt = now();
    });
    await this.store.updateCreationRequest(task.creationRequestId, (draft) => {
      draft.status = "completed";
      draft.workId = work.id;
    });
    await this.store.updateCredits((credits) => {
      credits.frozen = Math.max(0, credits.frozen - task.requiredCredits);
      credits.used += task.requiredCredits;
    });
    await this.#transition(taskId, "success", "completed", 100, "任务已完成");
  }

  async #generateImageWithFallback(task) {
    try {
      return await this.providers.image.generate(task, { onProgress: (event) => this.#handleProviderProgress(task.id, event) });
    } catch (error) {
      if (!this.providers.imageFallback) {
        throw error;
      }

      await this.#appendProviderWarning(task.id, error.message);
      return this.providers.imageFallback.generate(task, { onProgress: (event) => this.#handleProviderProgress(task.id, event) });
    }
  }

  async #generateVideoWithFallback(task) {
    try {
      return await this.providers.video.generate(task, { onProgress: (event) => this.#handleProviderProgress(task.id, event) });
    } catch (error) {
      if (!this.providers.videoFallback) {
        throw error;
      }

      await this.#appendProviderWarning(task.id, error.message);
      return this.providers.videoFallback.generate(task, { onProgress: (event) => this.#handleProviderProgress(task.id, event) });
    }
  }

  async #handleProviderProgress(taskId, event) {
    const task = await this.store.getTaskById(taskId);
    if (!task || task.status !== "running") {
      return;
    }

    await this.store.updateTask(taskId, (draft) => {
      if (typeof event.progress === "number") {
        draft.progress = Math.max(draft.progress, Math.min(event.progress, 74));
      }
      if (event.externalTaskId) {
        draft.externalTaskId = event.externalTaskId;
      }
      if (event.note) {
        draft.providerNote = event.note;
      }
    });
  }

  async #appendProviderWarning(taskId, message) {
    const task = await this.store.getTaskById(taskId);
    if (!task) {
      return;
    }

    await this.store.appendTaskHistory({
      id: crypto.randomUUID(),
      taskId,
      fromStatus: task.status,
      toStatus: task.status,
      stage: task.currentStage,
      message: `主生成通道失败，已切换备用通道：${message}`,
      createdAt: now(),
    });
  }

  async #markFailed(taskId, errorCode, errorMessage) {
    const task = await this.store.getTaskById(taskId);
    if (!task || ["failed", "success", "cancelled"].includes(task.status)) {
      return;
    }

    await this.store.updateTask(taskId, (draft) => {
      draft.status = "failed";
      draft.currentStage = "failing";
      draft.progress = Math.min(draft.progress, 95);
      draft.errorCode = errorCode;
      draft.errorMessage = errorMessage;
      draft.finishedAt = now();
    });
    await this.store.updateCreationRequest(task.creationRequestId, (draft) => {
      draft.status = "failed";
    });
    await this.store.appendTaskHistory({
      id: crypto.randomUUID(),
      taskId,
      fromStatus: task.status,
      toStatus: "failed",
      stage: "failing",
      message: errorMessage,
      createdAt: now(),
    });
    await this.#releaseCredits(task.requiredCredits);
  }

  async #releaseCredits(requiredCredits) {
    await this.store.updateCredits((credits) => {
      credits.frozen = Math.max(0, credits.frozen - requiredCredits);
      credits.available += requiredCredits;
    });
  }

  async #transition(taskId, nextStatus, nextStage, progress, message) {
    const task = await this.store.getTaskById(taskId);
    if (!task) {
      return;
    }

    const prevStatus = task.status;
    await this.store.updateTask(taskId, (draft) => {
      draft.status = nextStatus;
      draft.currentStage = nextStage;
      draft.progress = progress;
    });
    await this.store.appendTaskHistory({
      id: crypto.randomUUID(),
      taskId,
      fromStatus: prevStatus,
      toStatus: nextStatus,
      stage: nextStage,
      message,
      createdAt: now(),
    });
  }
}
