import { promises as fs } from "node:fs";
import path from "node:path";
import { aspectToOpenAiImageSize, now, sleep } from "../media-utils.js";

export class ModelScopeImageProvider {
  constructor({ assetsDir, apiKey, model, baseUrl }) {
    this.assetsDir = assetsDir;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.name = "modelscope-image";
  }

  async generate(task, options = {}) {
    const size = aspectToOpenAiImageSize(task.aspectRatio);
    const createPayload = await this.#createTask({
      model: this.model,
      prompt: task.prompt,
      parameters: {
        size,
      },
    });

    const taskId = createPayload.task_id || createPayload.output?.task_id;
    if (!taskId) {
      throw new Error("图片生成服务没有返回任务编号");
    }

    if (options.onProgress) {
      await options.onProgress({
        progress: 42,
        note: "图片生成任务已提交",
        externalTaskId: taskId,
      });
    }

    const result = await this.#pollTask(taskId, options.onProgress);
    const outputImage =
      result.output_images?.[0] ||
      result.output?.output_images?.[0] ||
      result.output?.images?.[0] ||
      result.images?.[0];

    const imageUrl = typeof outputImage === "string" ? outputImage : outputImage?.url;
    if (!imageUrl) {
      throw new Error("图片生成完成，但没有返回图片地址");
    }

    const imageResponse = await fetch(imageUrl, {
      signal: AbortSignal.timeout(60000),
    });
    if (!imageResponse.ok) {
      throw new Error(`下载生成图片失败：${imageResponse.status}`);
    }

    const fileName = `${task.id}.png`;
    const filePath = path.join(this.assetsDir, fileName);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    await fs.writeFile(filePath, imageBuffer);
    const stat = await fs.stat(filePath);

    return {
      provider: this.name,
      revisedPrompt: null,
      taskId,
      requestedAt: now(),
      outputs: [
        {
          type: "image",
          title: "生成图片",
          filePath,
          publicPath: `/storage/assets/${fileName}`,
          mimeType: "image/png",
          width: size === "1024x1024" ? 1024 : size === "1024x1536" ? 1024 : 1536,
          height: size === "1024x1024" ? 1024 : size === "1024x1536" ? 1536 : 1024,
          size: stat.size,
          provider: this.name,
        },
      ],
    };
  }

  async #createTask(requestBody) {
    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-ModelScope-Async-Mode": "true",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000),
    });

    const payload = await this.#safeJson(response);
    if (!response.ok) {
      throw this.#buildError(payload, response.status, "创建图片生成任务失败");
    }

    return payload;
  }

  async #pollTask(taskId, onProgress) {
    const maxAttempts = 60;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await sleep(attempt === 0 ? 1200 : 2000);
      const response = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "X-ModelScope-Task-Type": "image_generation",
        },
        signal: AbortSignal.timeout(30000),
      });

      const payload = await this.#safeJson(response);
      if (!response.ok) {
        throw this.#buildError(payload, response.status, "查询图片生成进度失败");
      }

      const taskStatus =
        payload.task_status ||
        payload.output?.task_status ||
        payload.status ||
        payload.output?.status;

      if (onProgress && ["PROCESSING", "PENDING", "RUNNING"].includes(taskStatus)) {
        const progress = Math.min(45 + attempt * 3, 72);
        await onProgress({
          progress,
          note: "图片生成处理中",
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
          payload.output?.error_message ||
          "图片生成任务失败";
        throw new Error(message);
      }
    }

    throw new Error("图片生成等待超时");
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
      payload?.error?.message ||
      payload?.raw ||
      `${fallbackMessage}: ${status}`;
    const error = new Error(message);
    error.code = "MODELSCOPE_IMAGE_FAILED";
    error.details = payload;
    return error;
  }
}
