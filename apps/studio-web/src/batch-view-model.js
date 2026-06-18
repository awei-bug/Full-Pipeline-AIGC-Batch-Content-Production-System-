function ensureList(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildAssetUrl(url, apiBaseUrl) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) {
    return "";
  }

  if (/^https?:\/\//i.test(normalizedUrl)) {
    return normalizedUrl;
  }

  const normalizedBaseUrl = normalizeBaseUrl(apiBaseUrl);
  if (!normalizedBaseUrl) {
    return normalizedUrl;
  }

  if (normalizedUrl.startsWith("/")) {
    return `${normalizedBaseUrl}${normalizedUrl}`;
  }

  return `${normalizedBaseUrl}/${normalizedUrl.replace(/^\/+/, "")}`;
}

function normalizeContentTypes(contentTypes) {
  return ensureList(contentTypes).filter(Boolean);
}

function getContentTypeLabel(contentType) {
  switch (contentType) {
    case "marketing_copy":
      return "营销文案";
    case "video_script":
      return "视频脚本";
    case "image_prompt":
      return "海报提示词";
    case "image_asset":
      return "效果图片";
    default:
      return "内容结果";
  }
}

function getContentTypeSummary(contentTypes) {
  const labels = normalizeContentTypes(contentTypes).map(getContentTypeLabel);
  return labels.length > 0 ? labels.join("、") : "未选择生成内容";
}

function getJobStatusPresentation(status) {
  switch (status) {
    case "success":
      return { label: "已完成", tone: "success" };
    case "partial_success":
      return { label: "部分完成", tone: "warning" };
    case "failed":
      return { label: "执行失败", tone: "danger" };
    case "running":
      return { label: "生成中", tone: "running" };
    case "queued":
    case "pending":
    case "created":
      return { label: "等待执行", tone: "pending" };
    default:
      return { label: "等待执行", tone: "pending" };
  }
}

function getStepStatus(activeBatch, latestJob, stepIndex) {
  if (!activeBatch) {
    return stepIndex === 0 ? "current" : "pending";
  }

  if (!latestJob) {
    if (stepIndex === 0) {
      return "done";
    }
    return stepIndex === 1 ? "current" : "pending";
  }

  if (stepIndex === 0) {
    return "done";
  }

  if (stepIndex === 1) {
    return ["success", "partial_success", "failed"].includes(latestJob.status) ? "done" : "current";
  }

  return "current";
}

function getStepStatusLabel(status) {
  switch (status) {
    case "done":
      return "已完成";
    case "current":
      return "当前步骤";
    default:
      return "待开始";
  }
}

function getSourcePresentation(generationMeta) {
  if (generationMeta?.fallbackUsed) {
    return {
      label: "系统兜底",
      tone: "fallback",
      icon: "🛡",
    };
  }

  if (generationMeta?.model || generationMeta?.sourceUrl || generationMeta?.source) {
    return {
      label: "模型生成",
      tone: "model",
      icon: "✨",
    };
  }

  return {
    label: "系统生成",
    tone: "system",
    icon: "•",
  };
}

function getReasonLabel(reason) {
  switch (reason) {
    case "invalid_json_response":
      return "模型返回格式异常，系统已自动切换为兜底内容。";
    case "missing_api_token":
      return "系统没有拿到模型密钥，已使用兜底内容保证任务继续执行。";
    case "provider_unavailable":
      return "模型服务暂时不可用，系统已切换为兜底内容。";
    default:
      return "";
  }
}

function getOutputText(output) {
  const data = output?.outputData || {};
  switch (output?.outputType) {
    case "marketing_copy":
      return [data.title, data.body].filter(Boolean).join("\n");
    case "video_script":
      return String(data.script || "").trim();
    case "image_prompt":
      return String(data.prompt || "").trim();
    case "image_asset":
      return String(data.prompt || "").trim();
    default:
      return JSON.stringify(data || {});
  }
}

function getImageUrl(output, apiBaseUrl) {
  return buildAssetUrl(output?.outputData?.metadata?.publicUrl, apiBaseUrl);
}

function shouldShowExpand(content, outputType) {
  if (outputType === "image_asset") {
    return false;
  }
  if (outputType === "video_script") {
    return String(content || "").length > 24;
  }
  return String(content || "").length > 40;
}

function buildResultCard(output, expandedResultIds, apiBaseUrl) {
  const content = getOutputText(output);
  const source = getSourcePresentation({
    ...(output?.outputData?.generationMeta || {}),
    sourceUrl: output?.outputData?.metadata?.sourceUrl,
  });
  const expanded = expandedResultIds.includes(output?.id);

  return {
    id: output?.id || "",
    type: output?.outputType || "unknown",
    typeLabel: getContentTypeLabel(output?.outputType),
    content,
    previewText:
      output?.outputType === "image_asset"
        ? "图片结果已生成，可直接预览和导出。"
        : expanded
          ? content
          : String(content).slice(0, 88).trim(),
    expanded,
    showExpand: shouldShowExpand(content, output?.outputType),
    copyText: content || getImageUrl(output, apiBaseUrl),
    sourceLabel: source.label,
    sourceTone: source.tone,
    sourceIcon: source.icon,
    reasonLabel: getReasonLabel(output?.outputData?.generationMeta?.reason),
    modelLabel: String(output?.outputData?.generationMeta?.model || "").trim(),
    imageUrl: output?.outputType === "image_asset" ? getImageUrl(output, apiBaseUrl) : "",
    createdAt: output?.createdAt || "",
  };
}

function buildFilters(outputs) {
  const counts = outputs.reduce(
    (result, output) => {
      const key = output?.outputType || "unknown";
      result[key] = (result[key] || 0) + 1;
      return result;
    },
    { all: outputs.length },
  );

  const orderedKeys = ["all", "marketing_copy", "video_script", "image_prompt", "image_asset"];
  return orderedKeys
    .filter((key) => counts[key] > 0 || key === "all")
    .map((key) => ({
      key,
      label: key === "all" ? "全部结果" : getContentTypeLabel(key),
      count: counts[key] || 0,
    }));
}

function sortJobs(jobs) {
  return [...jobs].sort((left, right) => {
    const rightValue = String(right?.createdAt || "");
    const leftValue = String(left?.createdAt || "");
    return rightValue.localeCompare(leftValue);
  });
}

function buildActiveBatch(activeBatch, activeProducts) {
  if (!activeBatch) {
    return null;
  }

  const count = activeBatch.productCount || activeProducts.length;
  return {
    ...activeBatch,
    title: activeBatch.fileName || "未命名批次",
    subtitle: `共 ${count} 条商品，已导入工作台`,
  };
}

function buildOverviewCards(batchCount, activeProducts, activeJobs, latestJob) {
  return [
    {
      label: "导入批次",
      value: String(batchCount),
      detail: `当前批次商品 ${activeProducts.length} 条`,
    },
    {
      label: "批量任务",
      value: String(activeJobs.length),
      detail: latestJob ? getContentTypeSummary(latestJob.contentTypes) : "等待创建任务",
    },
    {
      label: "完成度",
      value: `${Number(latestJob?.progress || 0)}%`,
      detail: latestJob ? getJobStatusPresentation(latestJob.status).label : "暂无任务进度",
    },
  ];
}

function buildProductTable(products) {
  return {
    columns: ["商品名称", "核心卖点", "价格", "分类", "目标人群", "使用场景"],
    rows: products.map((product) => ({
      id: product.id,
      cells: [
        product.name || product.productName || "未命名商品",
        product.sellingPoint || product.highlight || "暂无卖点",
        String(product.price || "未填写"),
        product.category || "未分类",
        product.audience || "未填写",
        product.scenario || "未填写",
      ],
    })),
    emptyMessage: "暂无商品数据，请先导入商品表。",
  };
}

function buildJobTable(jobs) {
  return {
    rows: jobs.map((job) => {
      const status = getJobStatusPresentation(job.status);
      return {
        id: job.id,
        jobNo: job.jobNo || job.id,
        contentTypeText: getContentTypeSummary(job.contentTypes),
        progress: Number(job.progress || 0),
        progressText: `${Number(job.progress || 0)}%`,
        statusLabel: status.label,
        statusTone: status.tone,
        createdAt: job.createdAt || "",
      };
    }),
    emptyMessage: "当前批次还没有创建内容任务。",
  };
}

function buildResultSection(latestJob, outputs, selectedResultType, expandedResultIds, apiBaseUrl) {
  const previewImage = outputs.find((item) => item.outputType === "image_asset") || null;
  const filters = buildFilters(outputs);
  const activeFilterKey =
    filters.find((item) => item.key === selectedResultType)?.key || filters[0]?.key || "all";
  const filteredOutputs =
    activeFilterKey === "all"
      ? outputs
      : outputs.filter((item) => item.outputType === activeFilterKey);
  const cards = filteredOutputs.map((output) => buildResultCard(output, expandedResultIds, apiBaseUrl));

  if (!latestJob && outputs.length === 0) {
    return {
      state: "empty",
      title: "等待生成结果",
      message: "导入商品并创建批量任务后，这里会集中展示文案、脚本、提示词和效果图片。",
      activeFilterKey,
      filters,
      cards,
      previewImageUrl: "",
    };
  }

  if (latestJob && ["created", "queued", "pending", "running"].includes(latestJob.status)) {
    return {
      state: "pending",
      title: "图片正在生成中",
      message: "任务已提交，系统正在继续生成剩余内容，请稍后刷新查看最终结果。",
      activeFilterKey,
      filters,
      cards,
      previewImageUrl: previewImage ? getImageUrl(previewImage, apiBaseUrl) : "",
    };
  }

  return {
    state: "ready",
    title: "生成结果",
    message: cards.length > 0 ? "" : "当前任务还没有可展示的结果。",
    activeFilterKey,
    filters,
    cards,
    previewImageUrl: previewImage ? getImageUrl(previewImage, apiBaseUrl) : "",
  };
}

export function deriveBatchWorkspaceView({
  batches,
  products,
  jobs,
  outputs,
  selectedBatchId = "",
  selectedResultType = "all",
  expandedResultIds = [],
  apiBaseUrl = "",
}) {
  const batchItems = ensureList(batches);
  const productItems = ensureList(products);
  const jobItems = sortJobs(ensureList(jobs));
  const outputItems = ensureList(outputs);
  const activeBatchRecord =
    batchItems.find((item) => item.id === selectedBatchId) || batchItems[0] || null;
  const activeProducts = activeBatchRecord
    ? productItems.filter((item) => item.batchId === activeBatchRecord.id)
    : [];
  const activeJobs = activeBatchRecord
    ? jobItems.filter((item) => item.batchId === activeBatchRecord.id)
    : [];
  const latestJob = activeJobs[0] || null;
  const latestOutputs = latestJob
    ? outputItems.filter((item) => item.jobId === latestJob.id || item.jobItemId)
    : [];
  const activeBatch = buildActiveBatch(activeBatchRecord, activeProducts);
  const steps = [
    { key: "import", title: "导入商品数据" },
    { key: "job", title: "创建批量任务" },
    { key: "result", title: "查看生成结果" },
  ].map((step, index) => {
    const status = getStepStatus(activeBatchRecord, latestJob, index);
    return {
      ...step,
      status,
      statusLabel: getStepStatusLabel(status),
    };
  });

  return {
    batchCount: batchItems.length,
    jobCount: jobItems.length,
    outputCount: outputItems.length,
    empty: batchItems.length === 0 && jobItems.length === 0 && outputItems.length === 0,
    emptyMessage: "先导入商品数据，再创建批量内容任务。",
    steps,
    activeBatch,
    activeProducts,
    activeJobs,
    latestJob,
    latestOutputs,
    overviewCards: buildOverviewCards(batchItems.length, activeProducts, activeJobs, latestJob),
    productTable: buildProductTable(activeProducts),
    jobTable: buildJobTable(activeJobs),
    resultSection: buildResultSection(
      latestJob,
      latestOutputs,
      selectedResultType,
      ensureList(expandedResultIds),
      apiBaseUrl,
    ),
    batchOptions: batchItems.map((batch) => ({
      id: batch.id,
      title: batch.fileName || "未命名批次",
      subtitle: `共 ${batch.productCount || 0} 条商品`,
      createdAt: batch.createdAt || "",
      selected: batch.id === (activeBatchRecord?.id || ""),
    })),
    selectedBatchId: activeBatchRecord?.id || "",
    activeProductCount: activeProducts.length,
    activeJobCount: activeJobs.length,
    latestImageAsset: latestOutputs.find((item) => item.outputType === "image_asset") || null,
    latestOutputCards: latestOutputs.map((output) =>
      buildResultCard(output, ensureList(expandedResultIds), apiBaseUrl),
    ),
  };
}
