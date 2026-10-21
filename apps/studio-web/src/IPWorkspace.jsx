import { useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "./batch-api.js";
import { StoryArc, WaitingOrbit } from "./Illustrations.jsx";

const stages = [
  { id: "research", label: "调研" }, { id: "draft", label: "撰写" },
  { id: "polish", label: "润色" }, { id: "review", label: "审核" },
];
// 章节行需要稳定 key，拖拽排序时才能保住输入焦点与光标位置
let chapterSeq = 0;
const nextChapterId = () => `ch-${++chapterSeq}`;
const blankChapter = () => ({ id: nextChapterId(), title: "", brief: "" });
const lastBatchKey = "ip-content-last-batch";
const visualStyles = [
  { id: "cinematic", label: "电影叙事" },
  { id: "character", label: "角色聚焦" },
  { id: "environment", label: "世界场景" },
];

async function api(path, options) {
  const response = await fetch(`${apiBaseUrl}/api/ip-content${path}`, {
    headers: { "Content-Type": "application/json" }, ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.detail || `请求失败 (${response.status})`);
  return payload.data;
}

function saveText(name, content) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  link.download = name.replace(/[\\/:*?"<>|]/g, "_") + ".txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function assetUrl(output) {
  const path = output?.metadata?.publicUrl;
  if (!path) return "";
  return /^https?:\/\//i.test(path) ? path : `${apiBaseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function IPWorkspace() {
  const [ipName, setIpName] = useState("");
  const [lore, setLore] = useState("");
  const [chapters, setChapters] = useState([blankChapter()]);
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [savedProject, setSavedProject] = useState(null);
  const [strategy, setStrategy] = useState("auto");
  const [batch, setBatch] = useState(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMode, setReviewMode] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [visualWorkflow, setVisualWorkflow] = useState(null);
  const [visualBusy, setVisualBusy] = useState(false);
  const [visualStyle, setVisualStyle] = useState("cinematic");
  const [visualOutputs, setVisualOutputs] = useState({ image: true, video: false });
  const [error, setError] = useState("");
  const [dragIndex, setDragIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const projectRequestId = useRef(0);

  useEffect(() => {
    const id = localStorage.getItem(lastBatchKey);
    if (!id) return;
    let active = true;
    api(`/batches/${encodeURIComponent(id)}`).then((data) => {
      if (active) { setBatch(data); setSelected(data.items[0]?.id || ""); }
    }).catch((cause) => { if (active) setError(`上次批次暂时无法读取：${cause.message}`); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    api("/projects").then((data) => { if (active) setProjects(data); })
      .catch((cause) => { if (active) setError(`设定库加载失败：${cause.message}`); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!batch || batch.status !== "running") return undefined;
    let active = true;
    const timer = setInterval(() => {
      api(`/batches/${encodeURIComponent(batch.id)}`).then((data) => {
        if (active) setBatch(data);
      }).catch((cause) => { if (active) setError(cause.message); });
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [batch?.id, batch?.status]);

  const current = batch?.items.find((item) => item.id === selected) || batch?.items[0];
  const finished = batch?.items.filter((item) => item.status === "completed").length || 0;
  const approved = batch?.items.filter((item) => item.result?.approved).length || 0;
  const dirtyProject = selectedProjectId && savedProject &&
    (ipName.trim() !== savedProject.name || lore.trim() !== savedProject.lore);

  useEffect(() => {
    const workflowId = current?.visualWorkflow?.id;
    setVisualWorkflow(null);
    if (!batch?.id || !current?.id || !workflowId || current.visualWorkflow?.stale) return undefined;
    let active = true;
    api(`/batches/${encodeURIComponent(batch.id)}/items/${encodeURIComponent(current.id)}/visuals`)
      .then((data) => { if (active) setVisualWorkflow(data); })
      .catch((cause) => { if (active && !String(cause.message).includes("过期")) setError(cause.message); });
    return () => { active = false; };
  }, [batch?.id, current?.id, current?.visualWorkflow?.id, current?.visualWorkflow?.stale]);

  useEffect(() => {
    if (!batch?.id || !current?.id || !["queued", "running"].includes(visualWorkflow?.status)) return undefined;
    let active = true;
    const timer = setInterval(() => {
      api(`/batches/${encodeURIComponent(batch.id)}/items/${encodeURIComponent(current.id)}/visuals`)
        .then((data) => { if (active) setVisualWorkflow(data); })
        .catch((cause) => { if (active) setError(cause.message); });
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [batch?.id, current?.id, visualWorkflow?.status]);

  async function loadProject(id) {
    const requestId = ++projectRequestId.current;
    setSelectedProjectId(id);
    setSavedProject(null);
    setIpName("");
    setLore("");
    setError("");
    if (!id) return;
    try {
      const project = await api(`/projects/${encodeURIComponent(id)}`);
      if (requestId !== projectRequestId.current) return;
      setSavedProject(project);
      setIpName(project.name);
      setLore(project.lore);
    } catch (cause) { if (requestId === projectRequestId.current) setError(cause.message); }
  }

  async function saveProject() {
    if (!ipName.trim() || !lore.trim()) { setError("请先填写 IP 名称和世界观设定"); return; }
    setSaving(true);
    setError("");
    try {
      const project = await api("/projects", { method: "POST", body: JSON.stringify({
        name: ipName.trim(), lore: lore.trim(),
        ...(selectedProjectId ? { projectId: selectedProjectId, expectedVersion: savedProject?.version } : {}),
      }) });
      setSavedProject(project);
      setSelectedProjectId(project.id);
      setProjects(await api("/projects"));
    } catch (cause) { setError(cause.message); }
    finally { setSaving(false); }
  }

  function updateChapter(index, field, value) {
    setChapters((items) => items.map((item, i) => i === index ? { ...item, [field]: value } : item));
  }

  /** 章节排序：拖拽与键盘（聚焦手柄后按 ↑ ↓）共用同一入口。 */
  function moveChapter(from, to) {
    setChapters((items) => {
      if (from === to || to < 0 || to >= items.length) return items;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  function resetDrag() {
    setDragIndex(null);
    setDropIndex(null);
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (selectedProjectId && (!savedProject || dirtyProject)) throw new Error("设定库已修改，请先保存再生成");
      const data = await api("/batches", { method: "POST", body: JSON.stringify({
        ipName: ipName.trim(), strategy,
        ...(selectedProjectId ? { projectId: selectedProjectId } : { lore: lore.trim() }),
        chapters: chapters.map((chapter) => ({ title: chapter.title.trim(), brief: chapter.brief.trim() })),
      }) });
      localStorage.setItem(lastBatchKey, data.id);
      setBatch(data);
      setSelected(data.items[0]?.id || "");
      window.scrollTo({ top: 0, behavior: "auto" });
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }

  async function retry(item) {
    setError("");
    try {
      await api(`/batches/${encodeURIComponent(batch.id)}/items/${encodeURIComponent(item.id)}/retry`, { method: "POST" });
      setBatch(await api(`/batches/${encodeURIComponent(batch.id)}`));
    } catch (cause) { setError(cause.message); }
  }

  async function review(item, decision) {
    setError("");
    setReviewBusy(true);
    try {
      await api(`/batches/${encodeURIComponent(batch.id)}/items/${encodeURIComponent(item.id)}/review`, {
        method: "POST", body: JSON.stringify({ decision, note: reviewNote.trim() }),
      });
      setReviewMode("");
      setReviewNote("");
      setBatch(await api(`/batches/${encodeURIComponent(batch.id)}`));
    } catch (cause) { setError(cause.message); }
    finally { setReviewBusy(false); }
  }

  async function revise(item) {
    setError("");
    setReviewBusy(true);
    try {
      await api(`/batches/${encodeURIComponent(batch.id)}/items/${encodeURIComponent(item.id)}/revise`, { method: "POST" });
      setBatch(await api(`/batches/${encodeURIComponent(batch.id)}`));
    } catch (cause) { setError(cause.message); }
    finally { setReviewBusy(false); }
  }

  async function startVisuals(item) {
    const outputs = Object.entries(visualOutputs).filter(([, enabled]) => enabled).map(([kind]) => kind);
    if (!outputs.length) { setError("请至少选择图片或视频中的一种"); return; }
    setError("");
    setVisualBusy(true);
    try {
      const workflow = await api(`/batches/${encodeURIComponent(batch.id)}/items/${encodeURIComponent(item.id)}/visuals`, {
        method: "POST", body: JSON.stringify({ outputs, style: visualStyle }),
      });
      setVisualWorkflow(workflow);
      setBatch(await api(`/batches/${encodeURIComponent(batch.id)}`));
    } catch (cause) { setError(cause.message); }
    finally { setVisualBusy(false); }
  }

  return <div className="ip-workspace">
    <div className="ip-intro">
      <div className="ip-intro-copy"><span className="ip-kicker">叙事内容 / 批量创作</span><h2>数字 IP 内容工作台</h2></div>
      <StoryArc className="illus illus-hero ip-intro-illus" />
      {batch && <button type="button" className="ip-quiet" onClick={() => { setBatch(null); setError(""); }}>新建批次</button>}
    </div>
    {error && <div className="ip-error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="关闭错误提示">×</button></div>}

    {!batch ? <form className="ip-compose" onSubmit={submit}>
      <div className="ip-section-head"><div><h3>创作设定</h3><p>世界观与角色档案</p></div><span>01 / 02</span></div>
      <div className="ip-form-grid">
        <label>设定库<select value={selectedProjectId} onChange={(event) => loadProject(event.target.value)}><option value="">新建设定</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · v{project.version}</option>)}</select></label>
        <label>IP 名称<input value={ipName} onChange={(event) => setIpName(event.target.value)} maxLength={120} required placeholder="例如：星港纪事" /></label>
        <label className="ip-lore">世界观 / 角色设定<textarea value={lore} onChange={(event) => setLore(event.target.value)} maxLength={30000} required rows={7} placeholder="写入世界规则、人物关系、时间线及不可改动的事实…" /></label>
        <div className="ip-project-actions"><span>{dirtyProject ? "设定尚未保存" : savedProject ? `已保存 · 版本 ${savedProject.version}` : ""}</span><button type="button" className="ip-quiet" disabled={saving} onClick={saveProject}>{saving ? "保存中…" : savedProject ? "更新设定库" : "保存设定库"}</button></div>
      </div>
      <div className="ip-section-head ip-chapter-heading"><div><h3>章节计划</h3><p>章节名称与剧情目标</p></div><span>{String(chapters.length).padStart(2, "0")} / 50</span></div>
      <div className="ip-chapter-list">{chapters.map((chapter, index) => (
        <div
          className={`ip-chapter-input ${dragIndex === index ? "is-dragging" : ""} ${dropIndex === index && dragIndex !== null && dragIndex !== index ? "is-drop-target" : ""}`}
          key={chapter.id}
          onDragOver={(event) => { event.preventDefault(); setDropIndex(index); }}
          onDrop={(event) => { event.preventDefault(); if (dragIndex !== null) moveChapter(dragIndex, index); resetDrag(); }}
          onDragEnd={resetDrag}
        >
          <button
            type="button"
            className="ip-drag"
            draggable
            title="拖动排序，或聚焦后按 ↑ ↓"
            aria-label={`调整第 ${index + 1} 章顺序：可拖动，或聚焦后按上下方向键`}
            onDragStart={(event) => { setDragIndex(index); event.dataTransfer.effectAllowed = "move"; }}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") { event.preventDefault(); moveChapter(index, index - 1); }
              if (event.key === "ArrowDown") { event.preventDefault(); moveChapter(index, index + 1); }
            }}
          >⠿</button>
          <span className="ip-chapter-number">{String(index + 1).padStart(2, "0")}</span>
          <label>章节标题<input value={chapter.title} onChange={(event) => updateChapter(index, "title", event.target.value)} required maxLength={120} placeholder="章节名称" /></label>
          <label>本章目标<input value={chapter.brief} onChange={(event) => updateChapter(index, "brief", event.target.value)} required maxLength={5000} placeholder="主要情节、角色行动、期望的结尾" /></label>
          <button type="button" className="ip-remove" title="删除章节" aria-label={`删除第 ${index + 1} 章`} disabled={chapters.length === 1} onClick={() => setChapters((items) => items.filter((_, i) => i !== index))}>×</button>
        </div>
      ))}</div>
      <div className="ip-compose-foot"><button type="button" className="ip-quiet" disabled={chapters.length >= 50} onClick={() => setChapters((items) => [...items, blankChapter()])}>+ 添加章节</button><div className="ip-submit-actions"><label>Prompt 策略<select value={strategy} onChange={(event) => setStrategy(event.target.value)}><option value="auto">A/B 自动分配</option><option value="A">A · 场景优先</option><option value="B">B · 设定优先</option></select></label><button className="ip-primary" type="submit" disabled={busy}>{busy ? "正在提交…" : `生成 ${chapters.length} 个章节`}</button></div></div>
    </form> : <div className="ip-results">
      <div className="ip-summary"><div><span className="ip-kicker">{batch.ipName}{batch.projectVersion ? ` · 设定 v${batch.projectVersion}` : ""}</span><h3>批次进度</h3></div><div className="ip-summary-count"><strong>{finished} <small>/ {batch.items.length}</small></strong><span>完成章节</span></div><div className="ip-summary-count"><strong>{approved}</strong><span>模型审核通过</span></div><span className={`ip-batch-state ip-state-${batch.status}`}>{batch.status === "running" ? "生成中" : batch.status === "completed" ? "已完成" : batch.status === "partial_failure" ? "部分失败" : batch.status === "needs_review" ? "等待复核" : "执行失败"}</span></div>
      {batch.variants && <div className="ip-variant-strip"><span>人工审核</span><span>A · {batch.variants.A.approved}/{batch.variants.A.reviewed} 通过</span><span>B · {batch.variants.B.approved}/{batch.variants.B.reviewed} 通过</span></div>}
      <div className="ip-result-grid"><nav className="ip-item-list" aria-label="章节列表">{batch.items.map((item, index) => <button type="button" key={item.id} className={`ip-item ${current?.id === item.id ? "is-selected" : ""}`} onClick={() => { setSelected(item.id); setReviewMode(""); setReviewNote(""); }}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong><em>{item.status === "completed" ? item.humanReview?.decision === "approved" ? "人工已通过" : item.staleContext ? "前文已变更" : "模型已通过" : item.status === "needs_review" ? "待人工复核" : item.status === "needs_revision" ? "待重写" : item.status === "failed" ? "失败" : item.status === "running" ? "生成中" : index > 0 && batch.items[index - 1]?.status !== "completed" ? "等待前章" : "排队中"}</em></button>)}</nav>
        {current && <article className="ip-detail"><div className="ip-detail-head"><div><span className="ip-kicker">章节成稿 · Prompt {current.promptVariant || "A"}</span><h3>{current.title}</h3></div>{current.result && <button className="ip-quiet" type="button" onClick={() => saveText(current.title, current.result.content)}>下载正文</button>}</div>
          <div className="ip-stage-list" aria-label="协作进度">{stages.map((stage, index) => {
            const activeIndex = stages.findIndex((s) => s.id === current.stage);
            const complete = current.stage === "complete" || current.status === "completed" || (activeIndex > index);
            const attention = stage.id === "review" && complete && current.result && !current.result.approved;
            return <div key={stage.id} className={`ip-stage ${complete ? "is-done" : ""} ${attention ? "is-attention" : ""} ${current.stage === stage.id && !complete ? "is-current" : ""}`}><i />{stage.label}</div>;
          })}</div>
          {current.status === "failed" && <div className="ip-task-error" role="alert"><strong>章节生成中断</strong><p>{current.error}</p><button className="ip-primary" type="button" onClick={() => retry(current)}>从检查点恢复</button></div>}
          {current.result ? <><div className="ip-document">{current.result.content}</div><div className={`ip-review ${current.result.approved ? "is-approved" : "is-rejected"}`}><div><strong>{current.result.approved ? current.continuityIncomplete ? "模型通过，待核对历史章节" : "模型审核通过" : "模型未通过，待人工复核"}</strong><span>{current.result.model} · {current.result.usage?.total_tokens ?? "--"} tokens</span></div>            <p>{current.result.review}</p></div>
            <AgentTracePanel result={current.result} />
            {current.staleContext && <p className="ip-context-warning">前章成稿已变更，本章需要重新检查连续性。</p>}
            {current.continuityIncomplete && <p className="ip-context-warning">较早章节的情节线索超出上下文容量。请对照完整前文人工复核，确认后再继续后续章节。</p>}
            <div className="ip-human-review"><div><strong>人工验收</strong><span>{current.humanReview?.decision === "approved" ? "已通过" : current.humanReview?.decision === "rejected" ? "已退回" : "待确认"}</span></div>
              {current.humanReview?.note && <p>{current.humanReview.note}</p>}
              {current.status === "needs_revision" ? <button type="button" className="ip-primary" disabled={reviewBusy} onClick={() => revise(current)}>按意见重写</button> : <div className="ip-review-actions"><button type="button" className="ip-quiet" disabled={reviewBusy} onClick={() => setReviewMode("rejected")}>退回修改</button><button type="button" className="ip-primary" disabled={reviewBusy || !!current.staleContext} onClick={() => review(current, "approved")}>通过成稿</button></div>}
              {reviewMode === "rejected" && current.status !== "needs_revision" && <div className="ip-feedback"><label>修改意见<textarea rows={3} value={reviewNote} maxLength={2000} onChange={(event) => setReviewNote(event.target.value)} placeholder="写明设定冲突或需要修改的情节" /></label><div><button className="ip-quiet" type="button" onClick={() => setReviewMode("")}>取消</button><button className="ip-primary" type="button" disabled={!reviewNote.trim() || reviewBusy} onClick={() => review(current, "rejected")}>确认退回</button></div></div>}
            </div>
            {current.humanReview?.decision === "approved" && <section className="ip-visual-production">
              <div className="ip-visual-head"><div><strong>视觉生产</strong><span>从已验收章节提炼关键场景</span></div>{visualWorkflow && <span className={`ip-visual-status is-${visualWorkflow.status}`}>{visualWorkflow.status === "running" || visualWorkflow.status === "queued" ? `${visualWorkflow.progress || 0}% 生成中` : visualWorkflow.status === "success" ? "素材已完成" : visualWorkflow.status === "partial_success" ? "部分完成" : "生成失败"}</span>}</div>
              <div className="ip-visual-controls">
                <label>视觉方向<select value={visualStyle} onChange={(event) => setVisualStyle(event.target.value)}>{visualStyles.map((style) => <option value={style.id} key={style.id}>{style.label}</option>)}</select></label>
                <fieldset><legend>输出类型</legend><label><input type="checkbox" checked={visualOutputs.image} onChange={(event) => setVisualOutputs((value) => ({ ...value, image: event.target.checked }))} /> 图片</label><label><input type="checkbox" checked={visualOutputs.video} onChange={(event) => setVisualOutputs((value) => ({ ...value, video: event.target.checked }))} /> 视频</label></fieldset>
                <button type="button" className="ip-primary" disabled={visualBusy || ["queued", "running"].includes(visualWorkflow?.status)} onClick={() => startVisuals(current)}>{visualBusy ? "正在启动…" : visualWorkflow ? "重新生成素材" : "生成视觉素材"}</button>
              </div>
              {visualWorkflow?.copy?.content && <details className="ip-visual-brief"><summary>查看视觉开发摘要</summary><p>{visualWorkflow.copy.content}</p></details>}
              {(visualWorkflow?.imageVariants?.length > 0 || visualWorkflow?.videoVariants?.length > 0) && <div className="ip-visual-assets">
                {[...(visualWorkflow.imageVariants || []), ...(visualWorkflow.videoVariants || [])].map((variant) => {
                  const url = assetUrl(variant.output);
                  const isVideo = variant.output?.assetType === "video";
                  return <article className={`ip-visual-asset is-${variant.status}`} key={variant.id}><div><strong>{isVideo ? "章节动态镜头" : "章节关键帧"}</strong><span>{variant.style?.label}</span></div>{url && isVideo ? <video src={url} controls preload="metadata" /> : url ? <img src={url} alt={`${current.title} ${variant.style?.label || "视觉素材"}`} /> : <p>{variant.errorMessage || "素材生成中…"}</p>}</article>;
                })}
              </div>}
              {visualWorkflow?.status === "failed" && <p className="ip-context-warning">{visualWorkflow.errorMessage || "视觉摘要生成失败，请稍后重试。"}</p>}
            </section>}
          </> : current.status !== "failed" ? <div className="ip-waiting"><WaitingOrbit className="illus illus-wait" />{current.status === "queued" ? "等待生成" : `正在${stages.find((stage) => stage.id === current.stage)?.label || "处理"}…`}</div> : null}
        </article>}</div>
    </div>}
  </div>;
}

// 协作轨迹：把后端多角色 agent 的运行记录（轨迹步骤、工具调用、跨角色消息、
// 人工接管标记）可视化，让「agent 协作」从黑盒变成可观测。
function AgentTracePanel({ result }) {
  const trace = result?.agentTrace || [];
  const messages = result?.agentMessages || [];
  const needsHuman = result?.needsHumanReview;
  if (!trace.length && !messages.length) return null;
  const roleLabel = { supervisor: "监督", researcher: "调研", writer: "撰写", editor: "润色", critic: "审核" };
  return (
    <details className="ip-collab-trace" open={needsHuman}>
      <summary>协作轨迹{needsHuman ? <span className="ip-trace-flag">需人工复核</span> : null}</summary>
      {needsHuman ? <p className="ip-trace-human">审核未通过或安全巡检拦截，已转入人工接管流程。</p> : null}
      {trace.length > 0 && (
        <ol className="ip-trace-list">
          {trace.map((step, i) => (
            <li key={i} className={`ip-trace-step is-${step.role}`}>
              <div className="ip-trace-head">
                <span className="ip-trace-role">{roleLabel[step.role] || step.role}</span>
                <span className="ip-trace-action">{step.action}</span>
              </div>
              {step.plan ? <div className="ip-trace-plan">计划：{Object.entries(step.plan).filter(([, v]) => v).map(([k]) => k).join("、")}</div> : null}
              {step.tool_calls?.length > 0 && (
                <ul className="ip-trace-tools">
                  {step.tool_calls.map((tool, j) => (
                    <li key={j}><code>{tool.name}</code>{tool.ok === false ? <em className="ip-trace-fail"> 失败</em> : null}</li>
                  ))}
                </ul>
              )}
              {step.eval?.metrics ? (
                <div className="ip-trace-eval">
                  评测 {Math.round((step.eval.score ?? 0) * 100)}%
                  {step.eval.passed ? " · 通过" : " · 未过"}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {messages.length > 0 && (
        <div className="ip-trace-messages">
          <strong>跨角色消息</strong>
          <ul>
            {messages.map((m, i) => (
              <li key={i}>
                <span className="ip-trace-role">{roleLabel[m.sender] || m.sender}</span>
                <span className="ip-trace-arrow">→</span>
                {m.recipient}：{m.content}
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
