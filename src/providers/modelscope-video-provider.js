import { promises as fs } from "node:fs";
import path from "node:path";
import { now, sleep } from "../media-utils.js";

export class ModelScopeVideoProvider {
  constructor({ assetsDir, apiKey, model, baseUrl, dataInspection }) {
    this.assetsDir = assetsDir;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.dataInspection = dataInspection;
    this.name = "modelscope-video";
  }

  async generate(task, options = {}) {
    const createPayload = await this.#createTask({
      model: this.model,
      prompt: task.prompt,
    });

    const taskId = createPayload.task_id || createPayload.output?.task_id;
    if (!taskId) {
      throw new Error("视频生成服务没有返回任务编号");
    }

    if (options.onProgress) {
      await options.onProgress({
        progress: 42,
        note: "视频生成任务已提交",
        externalTaskId: taskId,
      });
    }

    const result = await this.#pollTask(taskId, options.onProgress);
    const videoUrl = this.#extractVideoUrl(result);
    if (!videoUrl) {
      throw new Error("视频生成完成，但没有返回视频地址");
    }

    const videoResponse = await fetch(videoUrl, {
      signal: AbortSignal.timeout(300000),
    });
    if (!videoResponse.ok) {
      throw new Error(`下载生成视频失败：${videoResponse.status}`);
    }

    const mimeType = videoResponse.headers.get("content-type") || "video/mp4";
    const extension = this.#inferExtension(videoUrl, mimeType);
    const fileName = `${task.id}.${extension}`;
    const filePath = path.join(this.assetsDir, fileName);
    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    await fs.writeFile(filePath, videoBuffer);
    const stat = await fs.stat(filePath);

    return {
      provider: this.name,
      revisedPrompt: null,
      taskId,
      requestedAt: now(),
      outputs: [
        {
          type: "video",
          title: "生成视频",
          filePath,
          publicPath: `/storage/assets/${fileName}`,
          mimeType,
          width: null,
          height: null,
          durationSec: task.durationSec ?? null,
          size: stat.size,
          provider: this.name,
        },
      ],
    };
  }

  async #createTask(requestBody) {
    const response = await fetch(`${this.baseUrl}/videos/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-ModelScope-Async-Mode": "true",
        "X-ModelScope-DataInspection": this.dataInspection,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000),
    });

    const payload = await this.#safeJson(response);
    if (!response.ok) {
      throw this.#buildError(payload, response.status, "创建视频生成任务失败");
    }

    if (payload.status === "FAILED" || payload.errors) {
      throw this.#buildError(payload, response.status, "创建视频生成任务失败");
    }

    return payload;
  }

  async #pollTask(taskId, onProgress) {
    const maxAttempts = 180;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await sleep(attempt === 0 ? 2000 : 5000);
      const response = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "X-ModelScope-Task-Type": "video_generation",
        },
        signal: AbortSignal.timeout(30000),
      });

      const payload = await this.#safeJson(response);
      if (!response.ok) {
        throw this.#buildError(payload, response.status, "查询视频生成进度失败");
      }

      const taskStatus =
        payload.task_status ||
        payload.output?.task_status ||
        payload.status ||
        payload.output?.status;

      if (onProgress && ["PROCESSING", "PENDING", "RUNNING"].includes(taskStatus)) {
        const progress = Math.min(45 + attempt, 72);
        await onProgress({
          progress,
          note: "视频生成处理中",
          externalTaskId: taskId,
        });
      }

      if (["SUCCEED", "SUCCESS", "COMPLETED"].includes(taskStatus)) {
        return payload;
      }

      if (["FAILED", "FAIL", "CANCELED", "CANCELLED"].includes(taskStatus)) {
        const message =
          payload.message ||
          payload.output?.message ||
          payload.errors?.message ||
          payload.output?.error_message ||
          "视频生成任务失败";
        throw new Error(message);
      }
    }

    throw new Error("视频生成等待超时");
  }

  #extractVideoUrl(payload) {
    const candidates = [
      payload.output_video,
      payload.output?.output_video,
      payload.output?.video_url,
      payload.video_url,
      payload.output?.video,
      payload.video,
      payload.output?.result_url,
      payload.result_url,
      payload.output_videos?.[0],
      payload.output?.output_videos?.[0],
      payload.output?.videos?.[0],
      payload.videos?.[0],
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate) {
        return candidate;
      }

      if (candidate?.url) {
        return candidate.url;
      }
    }

    return null;
  }

  #inferExtension(videoUrl, mimeType) {
    if (mimeType.includes("quicktime")) {
      return "mov";
    }

    if (mimeType.includes("webm")) {
      return "webm";
    }

    if (mimeType.includes("gif")) {
      return "gif";
    }

    const normalizedUrl = videoUrl.split("?")[0].toLowerCase();
    if (normalizedUrl.endsWith(".mov")) {
      return "mov";
    }
    if (normalizedUrl.endsWith(".webm")) {
      return "webm";
    }
    if (normalizedUrl.endsWith(".gif")) {
      return "gif";
    }

    return "mp4";
  }

  async #safeJson(response) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  #buildError(payload, status, fallbackMessage) {
    const message =
      payload?.message ||
      payload?.errors?.message ||
      payload?.error?.message ||
      payload?.raw ||
      `${fallbackMessage}: ${status}`;
    const error = new Error(message);
    error.code = "MODELSCOPE_VIDEO_FAILED";
    error.details = payload;
    return error;
  }
}
