import crypto from "node:crypto";
import sharp from "sharp";

export function now() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hash(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function pickPalette(seed) {
  const palettes = [
    ["#0f172a", "#1d4ed8", "#38bdf8"],
    ["#1f2937", "#0f766e", "#2dd4bf"],
    ["#111827", "#b91c1c", "#fb7185"],
    ["#1e1b4b", "#9333ea", "#f59e0b"],
    ["#14532d", "#16a34a", "#fde047"],
  ];
  const index = Number.parseInt(seed.slice(0, 2), 16) % palettes.length;
  return palettes[index];
}

export function aspectToCanvasSize(aspectRatio, mode) {
  const sizes = {
    image: {
      "1:1": { width: 1024, height: 1024 },
      "16:9": { width: 1280, height: 720 },
      "9:16": { width: 720, height: 1280 },
      "4:3": { width: 1200, height: 900 },
    },
    video: {
      "1:1": { width: 720, height: 720 },
      "16:9": { width: 960, height: 540 },
      "9:16": { width: 540, height: 960 },
      "4:3": { width: 800, height: 600 },
    },
  };

  return sizes[mode][aspectRatio] ?? sizes[mode]["16:9"];
}

export function aspectToOpenAiImageSize(aspectRatio) {
  const mapping = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "4:3": "1536x1024",
    "9:16": "1024x1536",
  };

  return mapping[aspectRatio] ?? "1536x1024";
}

export function trimPrompt(prompt, max = 96) {
  return prompt.length > max ? `${prompt.slice(0, max - 3)}...` : prompt;
}

export function wrapText(text, maxLineLength = 18) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLineLength && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.slice(0, 4);
}

export function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function getStyleLabel(styleCode) {
  const labels = {
    cinematic: "电影感",
    realistic: "写实",
    cyberpunk: "赛博朋克",
    minimal: "极简",
    default: "默认",
  };
  return labels[styleCode] || "默认";
}

export function createSvg({ kind, styleCode, width, height, palette, frameIndex, totalFrames }) {
  const lines = kind === "video" ? ["视频预览", "本地生成"] : ["图片预览", "本地生成"];
  const [bg1, bg2, accent] = palette;
  const offset = totalFrames > 1 ? Math.round((frameIndex / totalFrames) * 180) : 40;
  const circleX = Math.round(width * 0.18 + offset);
  const circleY = Math.round(height * 0.22 + offset / 3);
  const rectY = Math.round(height * 0.7 - offset / 8);
  const title = kind === "video" ? "视频预览" : "图片预览";
  const lineHeight = width > height ? 56 : 42;
  const textStartY = Math.round(height * 0.42);
  const subtitle = kind === "video"
    ? `风格：${getStyleLabel(styleCode)} · 第 ${frameIndex + 1} 帧 / 共 ${totalFrames} 帧`
    : `风格：${getStyleLabel(styleCode)} · 本地预览结果`;

  const lineElements = lines
    .map(
      (line, index) =>
        `<text x="72" y="${textStartY + index * lineHeight}" font-size="${width > height ? 40 : 34}" font-family="Segoe UI, Arial" font-weight="700" fill="#f8fafc">${escapeXml(line)}</text>`,
    )
    .join("");

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="${bg1}" />
          <stop offset="55%" stop-color="${bg2}" />
          <stop offset="100%" stop-color="#020617" />
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${accent}" stop-opacity="0.95" />
          <stop offset="100%" stop-color="${accent}" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#bg)" />
      <circle cx="${circleX}" cy="${circleY}" r="${Math.round(width * 0.12)}" fill="url(#glow)" />
      <rect x="50" y="${rectY}" width="${Math.round(width * 0.84)}" height="${Math.round(height * 0.22)}" rx="18" fill="rgba(15,23,42,0.55)" stroke="rgba(248,250,252,0.12)" />
      <text x="72" y="96" font-size="28" font-family="Segoe UI, Arial" fill="rgba(248,250,252,0.8)">${title}</text>
      ${lineElements}
      <text x="72" y="${height - 64}" font-size="24" font-family="Segoe UI, Arial" fill="rgba(248,250,252,0.74)">${escapeXml(subtitle)}</text>
    </svg>
  `;
}

export async function renderPng(outputPath, options) {
  const svg = createSvg(options);
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

export async function renderRawFrame(options) {
  const svg = createSvg(options);
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    rgba: new Uint8Array(data),
    width: info.width,
    height: info.height,
  };
}
