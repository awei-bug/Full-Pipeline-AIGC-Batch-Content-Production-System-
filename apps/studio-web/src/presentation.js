const aspectRatioMap = {
  "9:16": "9 / 16",
  "16:9": "16 / 9",
  "1:1": "1 / 1",
};

const styleSummaryMap = {
  cinematic: "强调光影层次、海报感和成片氛围。",
  realistic: "尽量贴近真实质感，让细节更可信。",
  cyberpunk: "增强霓虹、夜景和未来城市的视觉张力。",
  minimal: "减少噪音，让主体和构图更干净。",
};

export function getStageAspectRatio({ latestAsset, formState }) {
  if (latestAsset?.width && latestAsset?.height) {
    return `${latestAsset.width} / ${latestAsset.height}`;
  }

  return aspectRatioMap[formState?.aspectRatio] || "9 / 16";
}

export function getStyleSummary(styleCode) {
  return styleSummaryMap[styleCode] || styleSummaryMap.cinematic;
}
