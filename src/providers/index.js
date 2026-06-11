import { LocalImageProvider } from "./local-image-provider.js";
import { ModelScopeImageProvider } from "./modelscope-image-provider.js";
import { LocalVideoProvider } from "./local-video-provider.js";
import { ModelScopeVideoProvider } from "./modelscope-video-provider.js";

export function buildProviders({ assetsDir, env }) {
  const localImage = new LocalImageProvider({ assetsDir });
  const localVideo = new LocalVideoProvider({ assetsDir });

  const imageMode = env.IMAGE_PROVIDER_MODE || "auto";
  const videoMode = env.VIDEO_PROVIDER_MODE || "auto";
  const modelScopeApiKey = env.MODELSCOPE_API_TOKEN || env.MODELSCOPE_API_KEY || null;
  const imageModel = env.MODELSCOPE_IMAGE_MODEL || "Qwen/Qwen-Image";
  const videoModel = env.MODELSCOPE_VIDEO_MODEL || "Wan-AI/Wan2.1-T2V-1.3B";
  const modelScopeBaseUrl = env.MODELSCOPE_BASE_URL || "https://api-inference.modelscope.cn/v1";
  const modelScopeVideoDataInspection = env.MODELSCOPE_VIDEO_DATA_INSPECTION || "{\"input\":false,\"output\":false}";

  let imageProvider = localImage;
  let imageFallbackProvider = null;
  let videoProvider = localVideo;
  let videoFallbackProvider = null;

  if ((imageMode === "modelscope" || imageMode === "auto") && modelScopeApiKey) {
    imageProvider = new ModelScopeImageProvider({
      assetsDir,
      apiKey: modelScopeApiKey,
      model: imageModel,
      baseUrl: modelScopeBaseUrl,
    });
    imageFallbackProvider = localImage;
  } else if (imageMode === "local") {
    imageProvider = localImage;
  }

  if ((videoMode === "modelscope" || videoMode === "auto") && modelScopeApiKey) {
    videoProvider = new ModelScopeVideoProvider({
      assetsDir,
      apiKey: modelScopeApiKey,
      model: videoModel,
      baseUrl: modelScopeBaseUrl,
      dataInspection: modelScopeVideoDataInspection,
    });
    videoFallbackProvider = localVideo;
  } else if (videoMode === "local") {
    videoProvider = localVideo;
  }

  return {
    image: imageProvider,
    imageFallback: imageFallbackProvider,
    video: videoProvider,
    videoFallback: videoFallbackProvider,
  };
}
