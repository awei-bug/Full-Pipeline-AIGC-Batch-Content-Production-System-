import { promises as fs } from "node:fs";
import path from "node:path";
import {
  hash,
  pickPalette,
  aspectToCanvasSize,
  renderPng,
} from "../media-utils.js";

export class LocalImageProvider {
  constructor({ assetsDir }) {
    this.assetsDir = assetsDir;
    this.name = "local-mock-image";
  }

  async generate(task, options = {}) {
    if (options.onProgress) {
      await options.onProgress({ progress: 70, note: "正在生成本地图片" });
    }

    const seed = hash(`${task.prompt}:${task.styleCode}:${task.aspectRatio}`);
    const palette = pickPalette(seed);
    const { width, height } = aspectToCanvasSize(task.aspectRatio, "image");
    const fileName = `${task.id}.png`;
    const filePath = path.join(this.assetsDir, fileName);

    await renderPng(filePath, {
      prompt: task.prompt,
      kind: "image",
      styleCode: task.styleCode,
      width,
      height,
      palette,
      frameIndex: 0,
      totalFrames: 1,
    });

    const stat = await fs.stat(filePath);
    return {
      provider: this.name,
      outputs: [
        {
          type: "image",
          title: "生成图片",
          filePath,
          publicPath: `/storage/assets/${fileName}`,
          mimeType: "image/png",
          width,
          height,
          size: stat.size,
          provider: this.name,
        },
      ],
    };
  }
}
