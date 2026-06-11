import { promises as fs } from "node:fs";
import path from "node:path";
import gifenc from "gifenc";
import {
  hash,
  pickPalette,
  aspectToCanvasSize,
  renderRawFrame,
} from "../media-utils.js";

const { GIFEncoder, quantize, applyPalette } = gifenc;

export class LocalVideoProvider {
  constructor({ assetsDir }) {
    this.assetsDir = assetsDir;
    this.name = "local-gif-video";
  }

  async generate(task, options = {}) {
    const seed = hash(`${task.prompt}:${task.styleCode}:${task.aspectRatio}:video`);
    const palette = pickPalette(seed);
    const { width, height } = aspectToCanvasSize(task.aspectRatio, "video");
    const fps = 8;
    const durationSec = Math.min(Math.max(Number(task.durationSec) || 4, 2), 8);
    const frameCount = durationSec * fps;

    const rawFrames = [];
    for (let index = 0; index < frameCount; index += 1) {
      if (options.onProgress) {
        const progress = 40 + Math.round((index / frameCount) * 35);
        await options.onProgress({ progress, note: `正在生成第 ${index + 1} 帧，共 ${frameCount} 帧` });
      }
      rawFrames.push(await renderRawFrame({
        prompt: task.prompt,
        kind: "video",
        styleCode: task.styleCode,
        width,
        height,
        palette,
        frameIndex: index,
        totalFrames: frameCount,
      }));
    }

    const gif = GIFEncoder();
    const globalPalette = quantize(rawFrames[0].rgba, 256);
    for (const frame of rawFrames) {
      const indexed = applyPalette(frame.rgba, globalPalette);
      gif.writeFrame(indexed, width, height, {
        palette: globalPalette,
        delay: Math.round(1000 / fps),
      });
    }
    gif.finish();

    const outputName = `${task.id}.gif`;
    const outputPath = path.join(this.assetsDir, outputName);
    await fs.writeFile(outputPath, gif.bytesView());
    const stat = await fs.stat(outputPath);

    return {
      provider: this.name,
      outputs: [
        {
          type: "video",
          title: "视频预览",
          filePath: outputPath,
          publicPath: `/storage/assets/${outputName}`,
          mimeType: "image/gif",
          width,
          height,
          durationSec,
          size: stat.size,
          provider: this.name,
        },
      ],
    };
  }
}
