import { useEffect, useMemo, useState } from "react";

import {
  apiBaseUrl,
  buildFieldMapping,
  createContentJob,
  createImportBatch,
  exportContentJob,
  listContentJobs,
  listImportBatches,
  listContentOutputs,
  listProducts,
  parseCsvText,
  parseImportFile,
} from "./batch-api.js";
import { deriveBatchWorkspaceView } from "./batch-view-model.js";

const defaultCsvText = [
  "商品名称,卖点,价格,分类,目标人群,使用场景",
  "防晒喷雾,清爽不黏腻，适合夏季通勤,89,个护美妆,都市白领,办公室补喷",
  "修护面膜,夜间补水修护，适合熬夜后使用,129,护肤,25-35岁女性,居家夜间护理",
].join("\n");

const contentTypeOptions = [
  {
    value: "marketing_copy",
    title: "营销文案",
    description: "商品标题、卖点摘要和成单文案",
  },
  {
    value: "video_script",
    title: "视频脚本",
    description: "短视频分段脚本和口播框架",
  },
  {
    value: "image_prompt",
    title: "海报提示词",
    description: "供图片模型直接使用的构图提示词",
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

export function App() {
  const [batches, setBatches] = useState([]);
  const [products, setProducts] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [selectedResultType, setSelectedResultType] = useState("all");
  const [expandedResultIds, setExpandedResultIds] = useState([]);
  const [csvText, setCsvText] = useState(defaultCsvText);
  const [fileName, setFileName] = useState("products.csv");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [selectedContentTypes, setSelectedContentTypes] = useState([
    "marketing_copy",
    "video_script",
    "image_prompt",
  ]);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [isCreatingJob, setIsCreatingJob] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

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

  async function loadWorkspace(preferredBatchId = "") {
    const [nextBatches, nextJobs] = await Promise.all([listImportBatches(), listContentJobs()]);
    const resolvedBatchId = preferredBatchId || selectedBatchId || nextBatches[0]?.id || "";
    const nextProducts = resolvedBatchId ? await listProducts(resolvedBatchId) : [];
    const activeJobs = nextJobs.filter((item) => item.batchId === resolvedBatchId);
    const nextOutputs = activeJobs[0]?.id ? await listContentOutputs(activeJobs[0].id) : [];

    setBatches(nextBatches);
    setJobs(nextJobs);
    setSelectedBatchId(resolvedBatchId);
    setProducts(nextProducts);
    setOutputs(nextOutputs);
    setExpandedResultIds([]);
    setSelectedResultType("all");
  }

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        setIsBootstrapping(true);
        setErrorMessage("");
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
    };
  }, []);

  useEffect(() => {
    if (!selectedBatchId) {
      setProducts([]);
      setOutputs([]);
      return;
    }

    let active = true;

    async function loadBatchDetails() {
      try {
        const nextProducts = await listProducts(selectedBatchId);
        const activeJobs = jobs.filter((item) => item.batchId === selectedBatchId);
        const nextOutputs = activeJobs[0]?.id ? await listContentOutputs(activeJobs[0].id) : [];
        if (active) {
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

  async function handleImport(event) {
    event.preventDefault();

    try {
      setIsImporting(true);
      setErrorMessage("");
      setSuccessMessage("");

      const parsed = parseCsvText(csvText);
      const fieldMapping = buildFieldMapping(parsed.headers);
      const result = await createImportBatch({
        fileName: fileName.trim() || "products.csv",
        rows: parsed.rows,
        fieldMapping,
      });

      await loadWorkspace(result.batchId);
      setSuccessMessage(`已导入 ${result.productCount} 条商品数据。`);
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
      setSuccessMessage(`已读取文件 ${parsed.fileName}，共 ${parsed.rows.length} 条商品。`);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      event.target.value = "";
    }
  }

  async function handleCreateJob() {
    if (!view.activeBatch?.id) {
      setErrorMessage("请先导入一个商品批次。");
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
      setSuccessMessage(`批量任务已创建，共 ${result.itemCount} 个商品子任务。`);
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
      link.download = result.fileName || "批量内容结果.xlsx";
      link.click();
      URL.revokeObjectURL(url);
      setSuccessMessage("结果已导出为 Excel 文件。");
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsExporting(false);
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

  return (
    <main className="workspace-page">
      <StatusToast kind="error" message={errorMessage} onClose={() => setErrorMessage("")} />
      <StatusToast kind="success" message={successMessage} onClose={() => setSuccessMessage("")} />

      <header className="workspace-header">
        <div className="workspace-title-block">
          <span className="workspace-eyebrow">全链路 AIGC 批量内容生产系统</span>
          <h1>导入商品表，一次生成批量营销内容</h1>
          <p>
            面向商家与自媒体团队的批量工作台。上传商品数据后，系统会集中生成营销文案、视频脚本、海报提示词和效果图片。
          </p>
        </div>

        <div className="overview-strip">
          {view.overviewCards.map((card) => (
            <div key={card.label} className="overview-card">
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <p>{card.detail}</p>
            </div>
          ))}
        </div>
      </header>

      <section className="step-strip" aria-label="操作步骤">
        {view.steps.map((step, index) => (
          <div key={step.key} className={`step-card step-${step.status}`}>
            <div className="step-index">{index + 1}</div>
            <div className="step-copy">
              <strong>{step.title}</strong>
              <span>{step.statusLabel}</span>
            </div>
          </div>
        ))}
      </section>

      <section className="workspace-shell">
        <section className="workspace-column left-column">
          <article className="panel panel-import">
            <div className="panel-top">
              <div>
                <span className="panel-kicker">步骤一</span>
                <h2>导入商品数据</h2>
              </div>
              <span className="panel-note">支持 CSV / XLSX / XLS</span>
            </div>

            <div className="action-cluster">
              <label className="upload-button">
                <input type="file" accept=".csv,.xlsx,.xls" onChange={handleSelectImportFile} />
                <span>上传文件</span>
              </label>
              <span className="action-hint">
                {selectedFileName ? `已选择 ${selectedFileName}` : "也可以直接粘贴 CSV 内容"}
              </span>
            </div>

            <form className="import-form" onSubmit={handleImport}>
              <label className="field-block">
                <span>批次文件名</span>
                <input
                  value={fileName}
                  onChange={(event) => setFileName(event.target.value)}
                  placeholder="例如：夏季防晒商品.csv"
                />
              </label>

              <label className="field-block">
                <span>商品数据</span>
                <textarea
                  value={csvText}
                  onChange={(event) => setCsvText(event.target.value)}
                  rows={11}
                  placeholder="第一行为表头，使用英文逗号分隔字段。"
                />
              </label>

              <button
                className="primary-button"
                type="submit"
                disabled={isImporting || isBootstrapping}
              >
                {isImporting ? "正在导入" : "创建导入批次"}
              </button>
            </form>
          </article>

          <article className="panel">
            <div className="panel-top">
              <div>
                <span className="panel-kicker">当前批次商品</span>
                <h2>商品清单</h2>
              </div>
              <span className="panel-note">{view.activeProductCount} 条</span>
            </div>

            {view.productTable.rows.length > 0 ? (
              <div className="table-shell">
                <div className="table-header-row">
                  {view.productTable.columns.map((column) => (
                    <span key={column}>{column}</span>
                  ))}
                </div>
                <div className="table-body">
                  {view.productTable.rows.map((row) => (
                    <div key={row.id} className="table-data-row">
                      {row.cells.map((cell, index) => (
                        <span key={`${row.id}-${index}`}>{cell}</span>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <strong>暂无商品数据</strong>
                <p>{view.productTable.emptyMessage}</p>
              </div>
            )}
          </article>
        </section>

        <section className="workspace-column center-column">
          <article className="panel">
            <div className="panel-top">
              <div>
                <span className="panel-kicker">步骤二</span>
                <h2>创建批量任务</h2>
              </div>
              <span className="panel-note">
                {view.activeBatch ? view.activeBatch.subtitle : "等待导入批次"}
              </span>
            </div>

            <div className="batch-selector-list">
              {view.batchOptions.length > 0 ? (
                view.batchOptions.map((batch) => (
                  <button
                    key={batch.id}
                    type="button"
                    className={`batch-option ${batch.selected ? "is-active" : ""}`}
                    onClick={() => setSelectedBatchId(batch.id)}
                  >
                    <strong>{batch.title}</strong>
                    <span>{batch.subtitle}</span>
                    <span>{formatDateTime(batch.createdAt)}</span>
                  </button>
                ))
              ) : (
                <div className="empty-state compact">
                  <strong>暂无导入批次</strong>
                  <p>{view.emptyMessage}</p>
                </div>
              )}
            </div>

            <div className="type-grid">
              {contentTypeOptions.map((option) => {
                const active = selectedContentTypes.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`type-card ${active ? "is-active" : ""}`}
                    onClick={() => handleToggleContentType(option.value)}
                  >
                    <strong>{option.title}</strong>
                    <span>{option.description}</span>
                  </button>
                );
              })}
            </div>

            <button
              className="primary-button"
              type="button"
              disabled={isCreatingJob || !view.activeBatch}
              onClick={handleCreateJob}
            >
              {isCreatingJob ? "正在创建任务" : "发起批量内容任务"}
            </button>
          </article>

          <article className="panel">
            <div className="panel-top">
              <div>
                <span className="panel-kicker">任务概览</span>
                <h2>任务清单</h2>
              </div>
              <span className="panel-note">{view.activeJobCount} 个</span>
            </div>

            {view.jobTable.rows.length > 0 ? (
              <div className="job-list">
                {view.jobTable.rows.map((row) => (
                  <div key={row.id} className="job-card">
                    <div className="job-card-header">
                      <div>
                        <strong>{row.jobNo}</strong>
                        <p>{row.contentTypeText}</p>
                      </div>
                      <span className={`job-status tone-${row.statusTone}`}>{row.statusLabel}</span>
                    </div>
                    <div className="progress-line">
                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: row.progressText }} />
                      </div>
                      <span>{row.progressText}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <strong>暂无批量任务</strong>
                <p>{view.jobTable.emptyMessage}</p>
              </div>
            )}
          </article>
        </section>

        <section className="workspace-column right-column">
          <article className="panel panel-results">
            <div className="panel-top">
              <div>
                <span className="panel-kicker">步骤三</span>
                <h2>{view.resultSection.title}</h2>
              </div>
              <button
                className="secondary-button"
                type="button"
                disabled={isExporting || !view.latestJob}
                onClick={handleExportLatestJob}
              >
                {isExporting ? "正在导出" : "导出结果"}
              </button>
            </div>

            {view.resultSection.message ? (
              <div className={`result-banner result-${view.resultSection.state}`}>
                {view.resultSection.message}
              </div>
            ) : null}

            <ResultFilterTabs
              filters={view.resultSection.filters}
              activeKey={view.resultSection.activeFilterKey}
              onChange={setSelectedResultType}
            />

            {view.resultSection.previewImageUrl ? (
              <div className="preview-card">
                <img src={view.resultSection.previewImageUrl} alt="生成效果图" />
              </div>
            ) : null}

            {view.resultSection.cards.length > 0 ? (
              <div className="result-list">
                {view.resultSection.cards.map((card) => (
                  <article key={card.id} className={`result-card tone-${card.sourceTone}`}>
                    <div className="result-card-head">
                      <div className="result-meta">
                        <span className="result-type">{card.typeLabel}</span>
                        <span className={`source-badge source-${card.sourceTone}`}>
                          <span className="source-icon">{card.sourceIcon}</span>
                          {card.sourceLabel}
                        </span>
                      </div>
                      <div className="result-actions">
                        <button type="button" onClick={() => handleCopyResult(card)}>
                          复制内容
                        </button>
                        {card.showExpand ? (
                          <button type="button" onClick={() => handleToggleExpand(card.id)}>
                            {card.expanded ? "收起" : "展开全文"}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {card.imageUrl ? (
                      <div className="result-image-shell">
                        <img src={card.imageUrl} alt={card.typeLabel} />
                      </div>
                    ) : null}

                    <pre className="result-content">
                      {card.expanded ? card.content : card.previewText || "暂无内容"}
                    </pre>

                    {card.reasonLabel ? <p className="result-reason">{card.reasonLabel}</p> : null}
                    {card.modelLabel ? <p className="result-model">模型：{card.modelLabel}</p> : null}
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <strong>
                  {view.resultSection.state === "pending" ? "正在生成中" : "暂无生成结果"}
                </strong>
                <p>
                  {view.resultSection.state === "pending"
                    ? "图片和文案会在任务完成后自动写回这里。"
                    : "创建任务后，这里会优先展示最终结果。"}
                </p>
              </div>
            )}
          </article>
        </section>
      </section>
    </main>
  );
}
