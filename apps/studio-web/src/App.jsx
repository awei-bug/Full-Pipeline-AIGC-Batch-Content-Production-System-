import { useEffect, useMemo, useRef, useState } from "react";

import {
  apiBaseUrl,
  buildFieldMapping,
  createContentJob,
  createImportBatch,
  exportContentJob,
  downloadListingPack,
  previewListingPack,
  pushListingPack,
  listContentJobs,
  listImportBatches,
  listContentOutputs,
  listProducts,
  parseCsvText,
  parseImportFile,
  sendChatMessage,
  startContentWorkflow,
  getContentWorkflow,
} from "./batch-api.js";
import { deriveBatchWorkspaceView, shouldPollContentJob } from "./batch-view-model.js";
import { EmptyCanvas, FlowNodes } from "./Illustrations.jsx";
import { IPWorkspace } from "./IPWorkspace.jsx";
import { getSystemTheme, setTheme as persistTheme } from "./theme.js";
import { AuthPanel, PermissionGate, usePermissionSession } from "./PermissionGate.jsx";
import { ACTIONS } from "./permissions.js";

const defaultCsvText = [
  "产品名称,核心卖点,报价/MOQ,品类,目标市场,应用场景",
  "不锈钢水杯,食品级材质，支持定制Logo,FOB $2.8 / MOQ 500,日用百货,美国/欧洲,礼品与商超渠道",
  "工业连接器,高防护等级，支持批量OEM,FOB $1.2 / MOQ 1000,电子元器件,东南亚/中东,设备配套与工程采购",
].join("\n");

const workflowStyleOptions = {
  image: [
    { id: "editorial", label: "杂志编辑感", prompt: "editorial fashion magazine, refined composition, art direction, premium typography space" },
    { id: "product-studio", label: "产品棚拍", prompt: "clean studio product photography, soft directional light, crisp details, commercial catalog" },
    { id: "lifestyle", label: "生活方式", prompt: "warm lifestyle scene, natural daylight, authentic human context, social media friendly" },
    { id: "minimal", label: "极简留白", prompt: "minimalist art direction, calm palette, generous negative space, modern brand campaign" },
  ],
  video: [
    { id: "short-drama", label: "剧情开场", prompt: "short-form narrative hook, fast opening beat, relatable scene, clear payoff" },
    { id: "product-demo", label: "产品展示", prompt: "cinematic product demonstration, macro details, smooth camera movement, benefit-led" },
    { id: "ugc", label: "真实种草", prompt: "authentic creator-style vertical video, handheld energy, natural reactions, social proof" },
    { id: "brand-film", label: "品牌大片", prompt: "cinematic brand film, controlled lighting, elegant pacing, emotional visual language" },
  ],
};

const initialWorkflowBrief =
  "为一款极简白色保温杯做一套小红书新品发布内容，突出轻便、保温和通勤场景，整体要有高级感。";

const workflowCopySystemPrompt = [
  "你是资深商业宣传文案策划。",
  "用户会用很直白的话描述产品、活动或修改要求。",
  "每次只输出一份可直接发布、并能继续指导图片和视频生成的最终中文宣传文案，不解释创作过程。",
  "文案应包含：主标题、宣传正文、3个核心卖点、行动号召、图片画面建议、短视频镜头脚本。",
  "信息不足时可以基于常见营销场景合理补全，但不要虚构价格、认证、功效或用户没有提供的事实。",
].join("");

const contentTypeOptions = [
  {
    value: "marketing_copy",
    title: "英文Listing",
    description: "产品标题、卖点 bullet 和英文描述",
  },
  {
    value: "image_asset",
    title: "产品图片",
    description: "根据文案生成产品主图或宣传图",
  },
  {
    value: "video_asset",
    title: "产品视频",
    description: "根据文案生成产品宣传视频",
  },
];

function formatDateTime(value) {
  if (!value) {
    return "刚刚";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getJobStatusLabel(status) {
  switch (status) {
    case "success":
      return "已完成";
    case "partial_success":
      return "部分完成";
    case "failed":
      return "执行失败";
    case "running":
      return "生成中";
    case "queued":
    case "pending":
    case "created":
      return "等待执行";
    default:
      return "暂无任务";
  }
}

function getWorkflowAssetUrl(output) {
  const url = String(output?.metadata?.publicUrl || output?.metadata?.url || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return url.startsWith("/") ? `${apiBaseUrl}${url}` : `${apiBaseUrl}/${url}`;
}

function getWorkflowStageLabel(status) {
  switch (status) {
    case "success": return "已完成";
    case "running": return "执行中";
    case "failed": return "失败";
    case "skipped": return "跳过";
    default: return "待执行";
  }
}

function WorkflowStage({ stage, index }) {
  return (
    <div className={`workflow-stage workflow-stage-${stage.status}`}>
      <div className="workflow-stage-marker">{stage.status === "success" ? "✓" : index + 1}</div>
      <div className="workflow-stage-copy">
        <strong>{stage.label}</strong>
        <span>{getWorkflowStageLabel(stage.status)}</span>
      </div>
      <div className="workflow-stage-progress"><i style={{ width: `${stage.progress || 0}%` }} /></div>
    </div>
  );
}

function WorkflowVariant({ variant, kind }) {
  const output = variant.output;
  const assetUrl = getWorkflowAssetUrl(output);
  const isImage = kind === "image";
  return (
    <article className={`workflow-variant workflow-variant-${variant.status}`}>
      <div className="workflow-variant-head">
        <span className="variant-index">{String(variant.id || "").split("_").pop()?.padStart(2, "0")}</span>
        <div><strong>{variant.style?.label || "风格分支"}</strong><span>{variant.status === "success" ? "生成完成" : variant.errorMessage || "等待生成"}</span></div>
      </div>
      {assetUrl && isImage ? <img src={assetUrl} alt={variant.style?.label || "生成图片"} /> : null}
      {assetUrl && !isImage ? <video src={assetUrl} controls preload="metadata" aria-label={variant.style?.label || "生成视频"} /> : null}
      {!assetUrl && variant.status === "running" ? <div className="workflow-asset-placeholder">正在生成素材…</div> : null}
      {!assetUrl && variant.status === "failed" ? <div className="workflow-asset-placeholder is-error">{variant.errorMessage || "该分支生成失败"}</div> : null}
    </article>
  );
}

function ResultFilterTabs({ filters, activeKey, onChange }) {
  return (
    <div className="result-filter-tabs" role="tablist" aria-label="结果类型筛选">
      {filters.map((filter) => (
        <button
          key={filter.key}
          type="button"
          className={`result-filter-tab ${activeKey === filter.key ? "is-active" : ""}`}
          onClick={() => onChange(filter.key)}
        >
          <span>{filter.label}</span>
          <strong>{filter.count}</strong>
        </button>
      ))}
    </div>
  );
}

function StatusToast({ kind, message, onClose }) {
  if (!message) {
    return null;
  }

  return (
    <div className={`status-toast status-toast-${kind}`}>
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="关闭提示">
        关闭
      </button>
    </div>
  );
}

function GuideEmpty({ title, message, actionLabel, onAction }) {
  return (
    <div className="guide-empty">
      <strong>{title}</strong>
      <p>{message}</p>
      {actionLabel && onAction ? (
        <button type="button" className="primary-button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function App() {
  const [batches, setBatches] = useState([]);
  const [products, setProducts] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [selectedResultType, setSelectedResultType] = useState("all");
  const [expandedResultIds, setExpandedResultIds] = useState([]);
  const [workspaceMode, setWorkspaceMode] = useState("ip");
  const [theme, setThemeState] = useState(() => document.documentElement.dataset.theme || getSystemTheme());
  // 会话与权限：探测后端 authMode，AUTH_MODE=off 时 permissions.bypass=true，
  // 所有权限检查放行，界面与改造前完全一致。
  const session = usePermissionSession(apiBaseUrl);
  const [authPanelOpen, setAuthPanelOpen] = useState(false);
  const [workflowCopyInput, setWorkflowCopyInput] = useState(initialWorkflowBrief);
  const [workflowCopyMessages, setWorkflowCopyMessages] = useState([
    {
      id: "welcome",
      role: "assistant",
      content:
        "直接告诉我你要宣传什么、给谁看、想突出什么。哪怕只说“帮我卖这个杯子”，我也会先整理成完整宣传文案，你还可以继续让我改。",
    },
  ]);
  const [workflowBrief, setWorkflowBrief] = useState(initialWorkflowBrief);
  const [workflowCopyDraft, setWorkflowCopyDraft] = useState("");
  const [workflowCopyModel, setWorkflowCopyModel] = useState("");
  const [isGeneratingWorkflowCopy, setIsGeneratingWorkflowCopy] = useState(false);
  const [workflowOutputMode, setWorkflowOutputMode] = useState("both");
  const [workflowImageStyleIds, setWorkflowImageStyleIds] = useState(["editorial", "product-studio", "lifestyle"]);
  const [workflowVideoStyleIds, setWorkflowVideoStyleIds] = useState(["product-demo", "ugc"]);
  const [workflowRun, setWorkflowRun] = useState(null);
  const [isStartingWorkflow, setIsStartingWorkflow] = useState(false);
  const [csvText, setCsvText] = useState(defaultCsvText);
  const [fileName, setFileName] = useState("export-products.csv");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [selectedContentTypes, setSelectedContentTypes] = useState([
    "marketing_copy",
    "image_asset",
    "video_asset",
  ]);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [isCreatingJob, setIsCreatingJob] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isPacking, setIsPacking] = useState(false);
  const [packPanelOpen, setPackPanelOpen] = useState(false);
  const [packPreview, setPackPreview] = useState(null);
  const [packPrices, setPackPrices] = useState({});
  const [packPublish, setPackPublish] = useState(false);
  const [commercePush, setCommercePush] = useState({ configured: false, tenantSlug: "" });
  const [pushResult, setPushResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const workspaceRequestIdRef = useRef(0);
  const selectedBatchIdRef = useRef(selectedBatchId);

  useEffect(() => {
    selectedBatchIdRef.current = selectedBatchId;
  }, [selectedBatchId]);

  const view = useMemo(
    () =>
      deriveBatchWorkspaceView({
        batches,
        products,
        jobs,
        outputs,
        selectedBatchId,
        selectedResultType,
        expandedResultIds,
        apiBaseUrl,
      }),
    [batches, products, jobs, outputs, selectedBatchId, selectedResultType, expandedResultIds],
  );

  async function loadWorkspace(preferredBatchId = "", options = {}) {
    const resetResultView = options.resetResultView ?? true;
    const requestId = workspaceRequestIdRef.current + 1;
    workspaceRequestIdRef.current = requestId;

    const [nextBatches, nextJobs] = await Promise.all([listImportBatches(), listContentJobs()]);
    const resolvedBatchId =
      preferredBatchId || selectedBatchIdRef.current || nextBatches[0]?.id || "";
    const nextProducts = resolvedBatchId ? await listProducts(resolvedBatchId) : [];
    const activeJobs = nextJobs.filter((item) => item.batchId === resolvedBatchId);
    const nextOutputs = activeJobs[0]?.id ? await listContentOutputs(activeJobs[0].id) : [];

    if (requestId !== workspaceRequestIdRef.current) {
      return resolvedBatchId;
    }

    setBatches(nextBatches);
    setJobs(nextJobs);
    setSelectedBatchId(resolvedBatchId);
    setProducts(nextProducts);
    setOutputs(nextOutputs);
    if (resetResultView) {
      setExpandedResultIds([]);
      setSelectedResultType("all");
    }
    return resolvedBatchId;
  }

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        setIsBootstrapping(true);
        setErrorMessage("");
        loadCommercePushState();
        await loadWorkspace();
      } catch (error) {
        if (active) {
          setErrorMessage(error.message);
        }
      } finally {
        if (active) {
          setIsBootstrapping(false);
        }
      }
    }

    bootstrap();

    return () => {
      active = false;
      workspaceRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!workflowRun?.id || ["success", "partial_success", "failed"].includes(workflowRun.status)) {
      return undefined;
    }

    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const nextRun = await getContentWorkflow(workflowRun.id);
        if (active) setWorkflowRun(nextRun);
      } catch (error) {
        if (active) setErrorMessage(error.message);
      }
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [workflowRun?.id, workflowRun?.status]);

  useEffect(() => {
    if (!selectedBatchId) {
      setProducts([]);
      setOutputs([]);
      return undefined;
    }

    let active = true;
    const requestId = workspaceRequestIdRef.current + 1;
    workspaceRequestIdRef.current = requestId;

    async function loadBatchDetails() {
      try {
        const nextProducts = await listProducts(selectedBatchId);
        const activeJobs = jobs.filter((item) => item.batchId === selectedBatchId);
        const nextOutputs = activeJobs[0]?.id ? await listContentOutputs(activeJobs[0].id) : [];
        if (active && requestId === workspaceRequestIdRef.current) {
          setProducts(nextProducts);
          setOutputs(nextOutputs);
        }
      } catch (error) {
        if (active) {
          setErrorMessage(error.message);
        }
      }
    }

    loadBatchDetails();

    return () => {
      active = false;
    };
  }, [jobs, selectedBatchId]);

  useEffect(() => {
    if (!selectedBatchId || !shouldPollContentJob(view.latestJob)) {
      return undefined;
    }

    let active = true;
    const timer = window.setInterval(async () => {
      try {
        await loadWorkspace(selectedBatchId, { resetResultView: false });
      } catch (error) {
        if (active) {
          setErrorMessage(error.message);
        }
      }
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedBatchId, view.latestJob?.id, view.latestJob?.status]);

  async function handleImport(event) {
    event.preventDefault();

    try {
      setIsImporting(true);
      setErrorMessage("");
      setSuccessMessage("");

      const parsed = parseCsvText(csvText);
      const fieldMapping = buildFieldMapping(parsed.headers);
      const result = await createImportBatch({
        fileName: fileName.trim() || "export-products.csv",
        rows: parsed.rows,
        fieldMapping,
      });

      await loadWorkspace(result.batchId);
      setSuccessMessage(`已导入 ${result.productCount} 条产品数据。`);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsImporting(false);
    }
  }

  async function handleSelectImportFile(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      setErrorMessage("");
      setSuccessMessage("");
      const parsed = await parseImportFile(file);
      const nextCsvText = [
        parsed.headers.join(","),
        ...parsed.rows.map((row) => parsed.headers.map((header) => row[header] ?? "").join(",")),
      ].join("\n");

      setFileName(parsed.fileName);
      setSelectedFileName(parsed.fileName);
      setCsvText(nextCsvText);
      setSuccessMessage(`已读取文件 ${parsed.fileName}，共 ${parsed.rows.length} 条产品。`);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      event.target.value = "";
    }
  }

  async function handleCreateJob() {
    if (!view.activeBatch?.id) {
      setErrorMessage("请先导入一个产品批次。");
      return;
    }

    if (selectedContentTypes.length === 0) {
      setErrorMessage("请至少选择一种生成内容。");
      return;
    }

    try {
      setIsCreatingJob(true);
      setErrorMessage("");
      setSuccessMessage("");

      const result = await createContentJob({
        batchId: view.activeBatch.id,
        contentTypes: selectedContentTypes,
      });

      await loadWorkspace(view.activeBatch.id);
      const dispatchHint =
        result.dispatchErrorCount > 0
          ? `，其中 ${result.dispatchErrorCount} 个子任务派发失败`
          : "";
      setSuccessMessage(`外贸内容任务已创建，共 ${result.itemCount} 个产品子任务${dispatchHint}。`);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsCreatingJob(false);
    }
  }

  async function handleExportLatestJob() {
    if (!view.latestJob?.id) {
      setErrorMessage("当前没有可导出的任务结果。");
      return;
    }

    try {
      setIsExporting(true);
      setErrorMessage("");
      const result = await exportContentJob(view.latestJob.id);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName || "外贸内容结果.xlsx";
      link.click();
      URL.revokeObjectURL(url);
      setSuccessMessage("结果已导出为 Excel 文件。");
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsExporting(false);
    }
  }

  async function loadCommercePushState() {
    try {
      const response = await fetch(`${apiBaseUrl}/api/health`);
      const payload = await response.json();
      setCommercePush({
        configured: Boolean(payload?.data?.commercePushConfigured),
        tenantSlug: payload?.data?.commercePushTenant || "",
      });
    } catch {
      setCommercePush({ configured: false, tenantSlug: "" });
    }
  }

  async function handleOpenPackPanel() {
    if (!view.latestJob?.id) {
      setErrorMessage("当前没有可打包的任务结果。");
      return;
    }

    try {
      setIsPacking(true);
      setErrorMessage("");
      const preview = await previewListingPack(view.latestJob.id);
      const initialPrices = {};
      for (const item of preview.data?.pending || []) {
        initialPrices[item.productId] = item.suggestedPrice ? String(item.suggestedPrice) : "";
      }
      setPackPrices(initialPrices);
      setPackPublish(Boolean(preview.data?.summary?.publish));
      setPackPreview(preview.data || null);
      setPackPanelOpen(true);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsPacking(false);
    }
  }

  async function handleDownloadPack() {
    if (!view.latestJob?.id) {
      return;
    }

    const prices = {};
    for (const [productId, value] of Object.entries(packPrices)) {
      const parsed = Number.parseFloat(String(value).replace(/[^\d.]/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) {
        prices[productId] = parsed;
      }
    }

    try {
      setIsPacking(true);
      const result = await downloadListingPack(view.latestJob.id, {
        prices,
        publish: packPublish,
      });
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName || "listing-pack.zip";
      link.click();
      URL.revokeObjectURL(url);
      setPackPanelOpen(false);
      const stillPending = (packPreview?.pending || []).filter(
        (item) => !prices[item.productId],
      ).length;
      setSuccessMessage(
        stillPending > 0
          ? `成品包已生成，仍有 ${stillPending} 件未填价格，导入商城时会被跳过。`
          : "成品包已生成，可上传到商家后台的成品包导入。",
      );
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsPacking(false);
    }
  }

  function collectPackPrices() {
    const prices = {};
    for (const [productId, value] of Object.entries(packPrices)) {
      const parsed = Number.parseFloat(String(value).replace(/[^\d.]/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) {
        prices[productId] = parsed;
      }
    }
    return prices;
  }

  async function handlePushToCommerce() {
    if (!view.latestJob?.id) {
      return;
    }

    try {
      setIsPacking(true);
      setErrorMessage("");
      setPushResult(null);
      const result = await pushListingPack(view.latestJob.id, {
        prices: collectPackPrices(),
        publish: packPublish,
      });
      setPushResult(result);
      setSuccessMessage(
        `已推送到商城：成功 ${result.createdCount} 件，失败 ${result.errorCount} 件。`,
      );
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsPacking(false);
    }
  }

  async function handleCopyResult(card) {
    try {
      await navigator.clipboard.writeText(card.copyText || "");
      setSuccessMessage(`已复制${card.typeLabel}内容。`);
    } catch {
      setErrorMessage("复制失败，请检查浏览器权限。");
    }
  }

  function toggleWorkflowStyle(kind, styleId) {
    const setter = kind === "image" ? setWorkflowImageStyleIds : setWorkflowVideoStyleIds;
    setter((current) => (
      current.includes(styleId)
        ? current.filter((item) => item !== styleId)
        : [...current, styleId]
    ));
  }

  async function handleStartWorkflow(event) {
    event?.preventDefault();
    const brief = workflowBrief.trim();
    const approvedCopy = workflowCopyDraft.trim();
    if (!approvedCopy) {
      setErrorMessage("请先在左侧生成或填写宣传文案，再生成图片或视频。");
      return;
    }
    const imageStyles = workflowOutputMode === "video"
      ? []
      : workflowStyleOptions.image.filter((style) => workflowImageStyleIds.includes(style.id));
    const videoStyles = workflowOutputMode === "image"
      ? []
      : workflowStyleOptions.video.filter((style) => workflowVideoStyleIds.includes(style.id));
    if (imageStyles.length === 0 && videoStyles.length === 0) {
      setErrorMessage(`请至少选择一种${workflowOutputMode === "video" ? "视频" : "图片"}风格。`);
      return;
    }

    try {
      setIsStartingWorkflow(true);
      setErrorMessage("");
      setSuccessMessage("");
      const run = await startContentWorkflow({
        brief: brief || approvedCopy,
        approvedCopy,
        copyModel: workflowCopyModel,
        imageStyles,
        videoStyles,
      });
      setWorkflowRun(run);
      setSuccessMessage("已采用确认后的宣传文案，开始生成图片和视频。");
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsStartingWorkflow(false);
    }
  }

  async function handleGenerateWorkflowCopy(event) {
    event?.preventDefault();
    const content = workflowCopyInput.trim();
    if (!content || isGeneratingWorkflowCopy) {
      return;
    }

    const nextUserMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
    };
    const requestMessages = [
      { role: "system", content: workflowCopySystemPrompt },
      ...workflowCopyMessages
        .filter((message) => message.id !== "welcome")
        .map(({ role, content: messageContent }) => ({
        role,
        content: messageContent,
        })),
      { role: "user", content },
    ];

    if (!workflowCopyDraft.trim()) {
      setWorkflowBrief(content);
    }
    setWorkflowCopyMessages((current) => [...current, nextUserMessage]);
    setWorkflowCopyInput("");
    setIsGeneratingWorkflowCopy(true);
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const result = await sendChatMessage(requestMessages);
      const generatedCopy = result.content || "";
      setWorkflowCopyMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: generatedCopy || "暂时没有生成内容，请换个说法再试一次。",
          model: result.model,
        },
      ]);
      if (generatedCopy) {
        setWorkflowCopyDraft(generatedCopy);
        setWorkflowCopyModel(result.model || "");
        setSuccessMessage("宣传文案已生成。你可以直接修改，或继续对话让 AI 调整。");
      }
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsGeneratingWorkflowCopy(false);
    }
  }

  function handleWorkflowCopySuggestion(suggestion) {
    setWorkflowCopyInput(suggestion);
  }

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    persistTheme(next);
    setThemeState(next);
  }

  function handleResetWorkflowCopy() {
    setWorkflowCopyMessages((current) => current.filter((message) => message.id === "welcome"));
    setWorkflowCopyInput("");
    setWorkflowBrief("");
    setWorkflowCopyDraft("");
    setWorkflowCopyModel("");
    setWorkflowRun(null);
    setErrorMessage("");
    setSuccessMessage("已清空，可以重新描述宣传需求。");
  }

  function handleToggleContentType(value) {
    setSelectedContentTypes((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  }

  function handleToggleExpand(cardId) {
    setExpandedResultIds((current) =>
      current.includes(cardId) ? current.filter((item) => item !== cardId) : [...current, cardId],
    );
  }

  const latestProgress = Number(view.latestJob?.progress || 0);
  const latestStatusLabel = getJobStatusLabel(view.latestJob?.status);
  const hasBatch = Boolean(view.activeBatch);
  const hasJob = Boolean(view.latestJob);
  function renderChatStep() {
    const runStages = workflowRun?.stages || [
      {
        id: "copy",
        label: workflowCopyDraft.trim() ? "宣传文案已确认" : "生成并确认宣传文案",
        status: workflowCopyDraft.trim() ? "success" : "current",
        progress: workflowCopyDraft.trim() ? 100 : 0,
      },
      {
        id: "images",
        label: `生成图片 · ${workflowImageStyleIds.length} 种风格`,
        status: workflowOutputMode === "video" ? "skipped" : "pending",
        progress: 0,
      },
      {
        id: "videos",
        label: `生成视频 · ${workflowVideoStyleIds.length} 种风格`,
        status: workflowOutputMode === "image" ? "skipped" : "pending",
        progress: 0,
      },
      { id: "complete", label: "汇总可发布内容", status: "pending", progress: 0 },
    ];
    const isRunning = workflowRun && ["queued", "running"].includes(workflowRun.status);
    const imageVariants = workflowRun?.imageVariants || [];
    const videoVariants = workflowRun?.videoVariants || [];

    return (
      <div className="workflow-page">
        <section className="workflow-intro">
          <div>
            <span className="hero-kicker">CONTENT WORKFLOW · AGNES</span>
            <h2>先把直白需求变成宣传文案，再生成对应图片或视频</h2>
            <p>先用日常语言说明你想宣传什么。文案可以反复调整和手动编辑，确认后再交给图片与视频模型，整条链路使用同一份内容依据。</p>
          </div>
          <div className="workflow-model-stack">
            <span><b>1</b> 直白描述 <strong>对话生成文案</strong></span>
            <span><b>2</b> 确认文案 <strong>支持人工修改</strong></span>
            <span><b>3</b> 生成素材 <strong>图片 / 视频</strong></span>
          </div>
          <FlowNodes className="illus illus-hero workflow-intro-illus" />
        </section>

        <div className="workflow-grid">
          <section className="workflow-authoring panel">
            <div className="workflow-section-head">
              <div><span className="panel-kicker">第一步</span><h2>和 AI 把宣传文案聊清楚</h2></div>
              <button className="workflow-reset-button" type="button" onClick={handleResetWorkflowCopy}>重新开始</button>
            </div>

            <div className="workflow-copy-chat" aria-live="polite">
              {workflowCopyMessages.map((message) => (
                <div key={message.id} className={`workflow-copy-message is-${message.role}`}>
                  <span>{message.role === "assistant" ? "AI 文案助手" : "我的要求"}</span>
                  <p>{message.content}</p>
                </div>
              ))}
              {isGeneratingWorkflowCopy ? (
                <div className="workflow-copy-message is-assistant is-loading">
                  <span>AI 文案助手</span>
                  <p>正在整理宣传文案…</p>
                </div>
              ) : null}
            </div>

            <form className="workflow-copy-composer" onSubmit={handleGenerateWorkflowCopy}>
              <textarea
                className="workflow-brief-input"
                value={workflowCopyInput}
                onChange={(event) => setWorkflowCopyInput(event.target.value)}
                rows={3}
                placeholder={workflowCopyDraft ? "继续说修改要求，例如：再简短一点，语气更有购买欲…" : "直接描述，例如：帮我宣传这款杯子，主要给上班族用，要显得高级…"}
                aria-label="宣传文案对话输入"
              />
              <div className="workflow-copy-composer-actions">
                <span>{workflowCopyInput.length} 字</span>
                {/* 文案生成走 /api/chat，后端要求 platform:ai_chat。 */}
                <PermissionGate permissions={session.permissions} action={ACTIONS.PLATFORM_AI_CHAT}>
                  <button className="primary-button workflow-copy-submit" type="submit" disabled={!workflowCopyInput.trim() || isGeneratingWorkflowCopy}>
                    {isGeneratingWorkflowCopy ? "正在生成…" : workflowCopyDraft ? "按要求修改文案" : "生成宣传文案"}
                  </button>
                </PermissionGate>
              </div>
            </form>

            <div className="workflow-copy-suggestions" aria-label="常用修改要求">
              {["压缩得更简洁", "语气更有购买欲", "改成小红书风格"].map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => handleWorkflowCopySuggestion(suggestion)}>{suggestion}</button>
              ))}
            </div>

            <div className="workflow-copy-editor">
              <div className="workflow-copy-editor-head">
                <div><strong>最终采用的宣传文案</strong><span>生成素材时会完整使用这里的内容</span></div>
                <span>{workflowCopyDraft.length} 字</span>
              </div>
              <textarea
                value={workflowCopyDraft}
                onChange={(event) => setWorkflowCopyDraft(event.target.value)}
                rows={11}
                placeholder="AI 生成的宣传文案会出现在这里，你也可以直接粘贴或手动填写文案。"
                aria-label="最终采用的宣传文案"
              />
            </div>
          </section>

          <aside className="workflow-production panel">
            <div className="workflow-section-head">
              <div><span className="panel-kicker">第二步</span><h2>用确认文案生成素材</h2></div>
              <span className="workflow-badge">{isRunning ? "正在生成" : workflowCopyDraft.trim() ? "文案已就绪" : "等待文案"}</span>
            </div>

            <form onSubmit={handleStartWorkflow}>
              <div className="workflow-output-mode" role="group" aria-label="选择生成类型">
                {[
                  { id: "image", label: "只生成图片" },
                  { id: "video", label: "只生成视频" },
                  { id: "both", label: "图片和视频" },
                ].map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    className={workflowOutputMode === mode.id ? "is-selected" : ""}
                    onClick={() => setWorkflowOutputMode(mode.id)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              <div className="workflow-options">
                {workflowOutputMode !== "video" ? (
                <div className="workflow-option-group">
                  <div className="workflow-option-title"><strong>图片分支</strong><span>{workflowImageStyleIds.length} 张</span></div>
                  <div className="workflow-style-list">
                    {workflowStyleOptions.image.map((style) => (
                      <button key={style.id} type="button" className={`workflow-style-chip ${workflowImageStyleIds.includes(style.id) ? "is-selected" : ""}`} onClick={() => toggleWorkflowStyle("image", style.id)}>
                        <i />{style.label}
                      </button>
                    ))}
                  </div>
                </div>
                ) : null}
                {workflowOutputMode !== "image" ? (
                <div className="workflow-option-group">
                  <div className="workflow-option-title"><strong>视频分支</strong><span>{workflowVideoStyleIds.length} 条</span></div>
                  <div className="workflow-style-list">
                    {workflowStyleOptions.video.map((style) => (
                      <button key={style.id} type="button" className={`workflow-style-chip ${workflowVideoStyleIds.includes(style.id) ? "is-selected" : ""}`} onClick={() => toggleWorkflowStyle("video", style.id)}>
                        <i />{style.label}
                      </button>
                    ))}
                  </div>
                </div>
                ) : null}
              </div>

              {/* 启动工作流对应后端 platform:generate，viewer 会被 403 拦住，
                  这里提前隐藏并说明原因。 */}
              <PermissionGate permissions={session.permissions} action={ACTIONS.PLATFORM_GENERATE}>
                <button className="primary-button workflow-run-button" type="submit" disabled={!workflowCopyDraft.trim() || isStartingWorkflow || isRunning}>
                  <span>{isStartingWorkflow ? "正在启动…" : isRunning ? "素材生成中…" : !workflowCopyDraft.trim() ? "请先生成宣传文案" : workflowOutputMode === "image" ? "根据文案生成图片" : workflowOutputMode === "video" ? "根据文案生成视频" : "根据文案生成图片和视频"}</span><b>→</b>
                </button>
              </PermissionGate>
            </form>

            <div className="workflow-progress-head">
              <div><strong>执行进度</strong><span>当前素材统一依据左侧确认文案生成</span></div>
              <strong className="workflow-progress-number">{workflowRun?.progress || 0}%</strong>
            </div>
            <div className="workflow-track">
              {runStages.map((stage, index) => <WorkflowStage key={stage.id} stage={stage} index={index} />)}
            </div>
            <div className="workflow-run-note">
              <span className={isRunning ? "workflow-pulse" : "workflow-idle"} />
              {workflowRun?.status === "partial_success" ? "部分分支完成，可先使用已生成素材。" : workflowRun?.status === "success" ? "图片和视频已按确认文案生成完成。" : isRunning ? `正在执行：${workflowRun.currentStage === "images" ? "图片风格分支" : workflowRun.currentStage === "videos" ? "视频风格分支" : "确认宣传文案"}` : workflowCopyDraft.trim() ? "文案已就绪，选择类型和风格后即可生成。" : "先在左侧完成宣传文案。"}
            </div>
          </aside>
        </div>

        {workflowRun ? (
          <section className="workflow-results">
            <div className="workflow-results-head"><div><span className="panel-kicker">工作流产出</span><h2>{workflowRun.status === "success" ? "可发布内容已就绪" : "正在收集每个分支的结果"}</h2></div><span>{imageVariants.length + videoVariants.length} 个视觉分支</span></div>
            {workflowRun.copy?.content ? <article className="workflow-copy-result"><div className="workflow-copy-label"><span>本次采用的宣传文案</span><small>{workflowRun.copy.model || "已确认文案"}</small></div><p>{workflowRun.copy.content}</p></article> : null}
            {imageVariants.length > 0 ? <div className="workflow-result-group"><div className="workflow-result-group-head"><strong>图片分支</strong><span>{imageVariants.length} 种风格</span></div><div className="workflow-variant-grid">{imageVariants.map((variant) => <WorkflowVariant key={variant.id} variant={variant} kind="image" />)}</div></div> : null}
            {videoVariants.length > 0 ? <div className="workflow-result-group"><div className="workflow-result-group-head"><strong>视频分支</strong><span>{videoVariants.length} 种风格</span></div><div className="workflow-variant-grid">{videoVariants.map((variant) => <WorkflowVariant key={variant.id} variant={variant} kind="video" />)}</div></div> : null}
          </section>
        ) : (
          <section className="workflow-empty"><EmptyCanvas className="illus illus-empty" /><div><strong>生成结果会集中显示在这里</strong><p>先通过对话得到宣传文案，确认后选择图片或视频，系统会严格沿用这份文案生成素材。</p></div></section>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <StatusToast kind="error" message={errorMessage} onClose={() => setErrorMessage("")} />
      <StatusToast kind="success" message={successMessage} onClose={() => setSuccessMessage("")} />

      <div className="main-panel">
        <header className="topbar">
          <div className="topbar-identity">
            <div className="brand-mark" aria-hidden="true" />
            <div className="topbar-title">
              <p className="eyebrow">多Agent数字IP内容生成平台</p>
              <h1>{workspaceMode === "ip" ? "数字 IP 创作" : "内容工作流"}</h1>
            </div>
          </div>

          <div className="workspace-switch" aria-label="工作区切换">
            <button type="button" className={workspaceMode === "ip" ? "is-active" : ""} onClick={() => setWorkspaceMode("ip")}>数字 IP 创作</button>
            <button type="button" className={workspaceMode === "content" ? "is-active" : ""} onClick={() => setWorkspaceMode("content")}>内容工作流</button>
          </div>

          <div className="topbar-status" aria-label="当前状态">
            {workspaceMode === "ip" ? <span className="model-pill">工作流 <strong>4 个 Agent</strong></span> : <span className="model-pill">文本模型 <strong>agnes-2.5-flash</strong></span>}
            {workspaceMode !== "ip" && <span className="system-status topbar-live">● 服务在线</span>}
            {session.authMode !== "off" ? (
              session.token ? (
                <button
                  type="button"
                  className="secondary-button session-signout"
                  onClick={session.signOut}
                  title={`角色：${session.roleCode || "无项目角色"}`}
                >
                  退出（{session.roleCode || "无角色"}）
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button session-signin"
                  onClick={() => setAuthPanelOpen((open) => !open)}
                >
                  {authPanelOpen ? "收起登录" : "登录"}
                </button>
              )
            ) : null}
            <button
              type="button"
              className="theme-toggle"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
              title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>
        </header>

        {authPanelOpen && session.authMode !== "off" && !session.token ? (
          <AuthPanel
            apiBaseUrl={apiBaseUrl}
            authMode={session.authMode}
            onAuthenticated={() => {
              setAuthPanelOpen(false);
              setSuccessMessage("已登录");
            }}
          />
        ) : null}

        {packPanelOpen && packPreview ? (
          <div className="pack-overlay" role="dialog" aria-modal="true">
            <div className="pack-panel">
              <div className="pack-panel-head">
                <div>
                  <h3>导出成品包</h3>
                  <p>
                    商品 {packPreview.summary.productCount} 件，图片 {packPreview.summary.imageCount} 张，
                    待补价 {packPreview.summary.pendingPriceCount} 件
                  </p>
                </div>
                <button
                  className="pack-close"
                  type="button"
                  onClick={() => setPackPanelOpen(false)}
                >
                  关闭
                </button>
              </div>

              {(packPreview.pending || []).length > 0 ? (
                <div className="pack-price-list">
                  <div className="pack-price-head">
                    <span>商品</span>
                    <span>零售价</span>
                  </div>
                  {packPreview.pending.map((item) => (
                    <div className="pack-price-row" key={item.productId}>
                      <span className="pack-price-name">{item.name}</span>
                      <input
                        className="pack-price-input"
                        type="text"
                        inputMode="decimal"
                        placeholder={item.suggestedPrice ? `FOB ${item.suggestedPrice}` : "填写零售价"}
                        value={packPrices[item.productId] || ""}
                        onChange={(event) =>
                          setPackPrices((current) => ({
                            ...current,
                            [item.productId]: event.target.value,
                          }))
                        }
                      />
                    </div>
                  ))}
                  <p className="pack-hint">
                    留空的商品不会写入 price，导入商城时会被跳过，不会瞎填价格。
                  </p>
                </div>
              ) : (
                <p className="pack-hint">所有商品都已有价格，可直接打包。</p>
              )}

              <label className="pack-publish">
                <input
                  type="checkbox"
                  checked={packPublish}
                  onChange={(event) => setPackPublish(event.target.checked)}
                />
                导入后直接上架（不勾选则为下架态，需人工确认后发布）
              </label>

              {packPreview.skipped?.length > 0 ? (
                <p className="pack-warning">
                  {packPreview.skipped.length} 件被跳过：
                  {packPreview.skipped.map((item) => `${item.name || item.productId}（${item.reason}）`).join("、")}
                </p>
              ) : null}

              {pushResult ? (
                <div className="pack-result">
                  <strong>推送结果</strong>
                  <span>
                    目标 {pushResult.target?.tenantSlug} · 成功 {pushResult.createdCount} 件 ·
                    失败 {pushResult.errorCount} 件
                  </span>
                  {(pushResult.errors || []).length > 0 ? (
                    <ul>
                      {pushResult.errors.slice(0, 5).map((item, index) => (
                        <li key={`${item.name}-${index}`}>
                          {item.name || "未命名"}：{item.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <div className="pack-panel-foot">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setPackPanelOpen(false)}
                >
                  取消
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={isPacking}
                  onClick={handleDownloadPack}
                >
                  下载成品包
                </button>
                {/* 推送到商城是对外动作，后端只允许 owner（content:publish）。
                    这里提前隐藏，避免非 owner 点了才吃 403。 */}
                <PermissionGate permissions={session.permissions} action={ACTIONS.CONTENT_PUBLISH}>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={isPacking || !commercePush.configured}
                    title={
                      commercePush.configured
                        ? `推送到 ${commercePush.tenantSlug}`
                        : "未配置商城直推参数"
                    }
                    onClick={handlePushToCommerce}
                  >
                    {isPacking ? "正在推送" : "推送到商城"}
                  </button>
                </PermissionGate>
              </div>

              {!commercePush.configured ? (
                <p className="pack-hint">
                  直推未开启。在 api-server 配置 COMMERCE_IMPORT_URL、COMMERCE_IMPORT_TOKEN、
                  COMMERCE_TENANT_SLUG 后可用，也可以先下载成品包手动上传。
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="main-content">{workspaceMode === "ip" ? <IPWorkspace /> : renderChatStep()}</div>
      </div>
    </div>
  );
}
