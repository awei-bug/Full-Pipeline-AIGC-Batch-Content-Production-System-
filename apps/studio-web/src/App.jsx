import { useEffect, useMemo, useState } from "react";

import {
  canSubmitRequestType,
  getRequestTypeHelpText,
  getRequestTypeLabel,
} from "./capabilities.js";
import { getStageAspectRatio, getStyleSummary } from "./presentation.js";
import { deriveResultView } from "./result-view.js";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:3100";
const videoGenerationEnabled = import.meta.env.VITE_ENABLE_VIDEO_GENERATION === "true";

const styleLabels = {
  cinematic: "电影感",
  realistic: "写实",
  cyberpunk: "赛博风",
  minimal: "极简",
};

function buildAssetUrl(asset) {
  const publicUrl = asset?.metadata?.publicUrl || asset?.publicUrl || "";
  if (publicUrl.startsWith("http://") || publicUrl.startsWith("https://")) {
    return publicUrl;
  }
  if (publicUrl.startsWith("/")) {
    return `${apiBaseUrl}${publicUrl}`;
  }
  return "";
}

function formatRequestType(value) {
  return getRequestTypeLabel(value);
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || "请求失败");
  }

  return payload.data;
}

export function App() {
  const [projects, setProjects] = useState([]);
  const [works, setWorks] = useState([]);
  const [activeTask, setActiveTask] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [formState, setFormState] = useState({
    requestType: "text_to_image",
    styleCode: "cinematic",
    aspectRatio: "9:16",
    prompt: "",
  });

  const currentProject = useMemo(
    () => projects.find((item) => item.id === projectId) || null,
    [projects, projectId],
  );
  const latestWork = useMemo(() => works[0] || null, [works]);
  const latestAsset = latestWork?.assets?.[0] || null;
  const latestAssetUrl = buildAssetUrl(latestAsset);
  const stageAspectRatio = useMemo(
    () =>
      getStageAspectRatio({
        latestAsset,
        formState,
      }),
    [formState, latestAsset],
  );
  const styleSummary = useMemo(() => getStyleSummary(formState.styleCode), [formState.styleCode]);
  const requestTypeHelpText = useMemo(
    () => getRequestTypeHelpText(formState.requestType),
    [formState.requestType],
  );
  const canSubmitCurrentRequestType = useMemo(
    () =>
      canSubmitRequestType(formState.requestType, {
        videoEnabled: videoGenerationEnabled,
      }),
    [formState.requestType],
  );
  const resultView = useMemo(
    () =>
      deriveResultView({
        latestWork,
        latestAssetUrl,
        activeTask,
      }),
    [activeTask, latestAssetUrl, latestWork],
  );

  async function ensureDefaultProject(items) {
    if (items.length) {
      return items;
    }

    const project = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "默认项目",
        description: "系统自动创建的默认项目",
      }),
    });

    return [project];
  }

  async function fetchWorks(nextProjectId) {
    if (!nextProjectId) {
      return [];
    }

    const result = await request(`/api/works?projectId=${nextProjectId}`);
    return result.items || [];
  }

  async function fetchTask(taskId) {
    if (!taskId) {
      return null;
    }

    return request(`/api/tasks/${taskId}`);
  }

  async function loadWorkspace(preferredProjectId = "") {
    const projectsResult = await request("/api/projects");
    const nextProjects = await ensureDefaultProject(projectsResult.items || []);
    const resolvedProjectId = preferredProjectId || projectId || nextProjects[0]?.id || "";
    const nextWorks = await fetchWorks(resolvedProjectId);

    setProjects(nextProjects);
    setProjectId(resolvedProjectId);
    setWorks(nextWorks);
  }

  async function refreshResults(nextProjectId = projectId, options = {}) {
    const { silent = false, taskId = activeTask?.id || null } = options;

    try {
      if (!silent) {
        setIsRefreshing(true);
      }
      setErrorMessage("");

      const [nextWorks, nextTask] = await Promise.all([fetchWorks(nextProjectId), fetchTask(taskId)]);

      setWorks(nextWorks);

      if (nextTask) {
        setActiveTask((current) => {
          if (!current || current.id !== nextTask.id) {
            return current;
          }
          return {
            ...current,
            ...nextTask,
          };
        });
      }
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      if (!silent) {
        setIsRefreshing(false);
      }
    }
  }

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        setIsLoading(true);
        setErrorMessage("");
        await loadWorkspace();
      } catch (error) {
        if (active) {
          setErrorMessage(error.message);
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    bootstrap();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!projectId) {
      return undefined;
    }

    const timer = setInterval(() => {
      refreshResults(projectId, { silent: true });
    }, 10000);

    return () => clearInterval(timer);
  }, [activeTask?.id, projectId]);

  useEffect(() => {
    if (!activeTask?.id) {
      return;
    }

    const matchedTaskId = latestWork?.latestVersion?.generationTaskId || null;
    if (matchedTaskId === activeTask.id && latestAssetUrl) {
      setActiveTask(null);
    }
  }, [activeTask, latestAssetUrl, latestWork]);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!projectId) {
      setErrorMessage("当前没有可用项目");
      return;
    }
    if (!formState.prompt.trim()) {
      setErrorMessage("请输入创作描述");
      return;
    }
    if (!canSubmitCurrentRequestType) {
      setErrorMessage(requestTypeHelpText);
      return;
    }

    try {
      setIsSubmitting(true);
      setErrorMessage("");

      const submittedRequestType = formState.requestType;
      const result = await request("/api/creation-requests", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          prompt: formState.prompt.trim(),
          requestType: submittedRequestType,
          styleCode: formState.styleCode,
          aspectRatio: formState.aspectRatio,
        }),
      });

      setActiveTask({
        id: result.taskId,
        requestType: submittedRequestType,
        status: "created",
        errorMessage: "",
      });
      setFormState((current) => ({
        ...current,
        prompt: "",
      }));
      await refreshResults(projectId, { taskId: result.taskId });
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="cinema-page">
      <div className="page-aura" />

      <section className="hero-band">
        <div className="hero-copy">
          <div className="eyebrow-row">
            <span className="hero-eyebrow">AI 内容生成</span>
            <span className="hero-chip">{formatRequestType(formState.requestType)}</span>
          </div>
          <h1>输入文本，生成图片结果</h1>
          <p>当前版本先把真实图片生成闭环做稳，视频生成保留为实验入口。</p>
        </div>

        <div className="hero-side">
          {currentProject ? <div className="project-chip">项目：{currentProject.name}</div> : null}
          <div className="hero-metrics">
            <div className="metric-card">
              <span className="metric-label">当前风格</span>
              <strong>{styleLabels[formState.styleCode] || "电影感"}</strong>
              <p className="metric-copy">{styleSummary}</p>
            </div>
            <div className="metric-card">
              <span className="metric-label">输出比例</span>
              <strong>{formState.aspectRatio}</strong>
              <p className="metric-copy">结果画面会按当前比例进入右侧放映窗。</p>
            </div>
          </div>
        </div>
      </section>

      <section className="studio-layout">
        <article className="studio-panel input-panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">创作控制台</div>
              <h2>输入内容</h2>
            </div>
            <span className="panel-tag">{isLoading ? "初始化中" : formatRequestType(formState.requestType)}</span>
          </div>

          <form className="creator-form" onSubmit={handleSubmit}>
            <div className="control-group">
              <span className="control-label">生成类型</span>
              <div className="segmented-group">
                <button
                  className={`segment-button ${formState.requestType === "text_to_image" ? "is-active" : ""}`}
                  type="button"
                  onClick={() => setFormState((current) => ({ ...current, requestType: "text_to_image" }))}
                >
                  {formatRequestType("text_to_image")}
                </button>
                <button
                  className={`segment-button ${formState.requestType === "text_to_video" ? "is-active" : ""}`}
                  type="button"
                  onClick={() => setFormState((current) => ({ ...current, requestType: "text_to_video" }))}
                >
                  {formatRequestType("text_to_video")}
                </button>
              </div>
              <p className="control-hint">{requestTypeHelpText}</p>
            </div>

            <div className="field-row">
              <label>
                <span>风格方向</span>
                <select
                  value={formState.styleCode}
                  onChange={(event) =>
                    setFormState((current) => ({ ...current, styleCode: event.target.value }))
                  }
                >
                  <option value="cinematic">电影感</option>
                  <option value="realistic">写实</option>
                  <option value="cyberpunk">赛博风</option>
                  <option value="minimal">极简</option>
                </select>
              </label>

              <div className="control-group">
                <span className="control-label">画面比例</span>
                <div className="ratio-group">
                  {[
                    { value: "9:16", label: "竖版 9:16" },
                    { value: "16:9", label: "横版 16:9" },
                    { value: "1:1", label: "方图 1:1" },
                  ].map((item) => (
                    <button
                      key={item.value}
                      className={`ratio-button ${formState.aspectRatio === item.value ? "is-active" : ""}`}
                      type="button"
                      onClick={() => setFormState((current) => ({ ...current, aspectRatio: item.value }))}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <label>
              <span>输入文本</span>
              <textarea
                value={formState.prompt}
                onChange={(event) => setFormState((current) => ({ ...current, prompt: event.target.value }))}
                placeholder="例如：生成一张冷色调角色海报，突出压迫感和电影级光影。"
                rows={10}
              />
            </label>

            <button
              className="generate-button"
              type="submit"
              disabled={isSubmitting || isLoading || !canSubmitCurrentRequestType}
            >
              <span className="generate-button-glow" />
              <span className="generate-button-text">
                {canSubmitCurrentRequestType ? (isSubmitting ? "提交中" : "开始生成") : "视频实验中"}
              </span>
            </button>
          </form>

          {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
        </article>

        <article className="studio-panel result-panel">
          <div className="panel-header">
            <div>
              <div className="panel-kicker">结果放映窗</div>
              <h2>最终效果</h2>
            </div>
            <button
              className="refresh-button"
              type="button"
              onClick={() => refreshResults()}
              disabled={!projectId || isRefreshing}
            >
              {isRefreshing ? "刷新中" : "刷新结果"}
            </button>
          </div>

          <div className="result-stage">
            {resultView.mode === "ready" ? (
              <div className="result-frame" style={{ aspectRatio: stageAspectRatio }}>
                <div className="result-preview">
                  {resultView.assetType === "text_to_video" ? (
                    <video className="preview-media" src={resultView.assetUrl} controls />
                  ) : (
                    <img className="preview-media" src={resultView.assetUrl} alt="生成结果" />
                  )}
                </div>
              </div>
            ) : null}

            {resultView.mode === "pending" ? (
              <div className="result-frame" style={{ aspectRatio: stageAspectRatio }}>
                <div className="result-placeholder result-placeholder-pending">
                  <div className="placeholder-spinner" />
                  <div className="placeholder-title">{resultView.title}</div>
                  <div className="placeholder-text">{resultView.message}</div>
                </div>
              </div>
            ) : null}

            {resultView.mode === "failed" ? (
              <div className="result-frame" style={{ aspectRatio: stageAspectRatio }}>
                <div className="result-placeholder result-placeholder-failed">
                  <div className="placeholder-title">{resultView.title}</div>
                  <div className="placeholder-text">{resultView.message}</div>
                </div>
              </div>
            ) : null}

            {resultView.mode === "empty" ? (
              <div className="result-frame" style={{ aspectRatio: stageAspectRatio }}>
                <div className="result-placeholder result-placeholder-empty">
                  <div className="placeholder-frame" />
                  <div className="placeholder-title">等待放映</div>
                  <div className="placeholder-text">{resultView.message}</div>
                </div>
              </div>
            ) : null}
          </div>
        </article>
      </section>
    </main>
  );
}
