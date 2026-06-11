const userCard = document.querySelector("#user-card");
const taskFeed = document.querySelector("#task-feed");
const worksGrid = document.querySelector("#works-grid");
const creationForm = document.querySelector("#creation-form");
const refreshWorksButton = document.querySelector("#refresh-works");
const durationField = document.querySelector("#duration-field");
const workCardTemplate = document.querySelector("#work-card-template");

let pollingTimer = null;

const kindLabels = {
  image: "图片",
  video: "视频",
};

const statusLabels = {
  created: "已创建",
  queued: "排队中",
  running: "生成中",
  post_processing: "处理中",
  reviewing: "审核中",
  success: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const styleLabels = {
  cinematic: "电影感",
  realistic: "写实",
  cyberpunk: "赛博朋克",
  minimal: "极简",
};

function formatAspectRatio(aspectRatio) {
  const labels = {
    "16:9": "横版 16:9",
    "1:1": "方图 1:1",
    "9:16": "竖版 9:16",
    "4:3": "标准 4:3",
  };

  return labels[aspectRatio] || aspectRatio;
}

function buildWorkTitle(work) {
  const kind = getKindLabel(work.kind);
  const style = getStyleLabel(work.styleCode);
  return `${style}${kind}`;
}

function buildWorkDescription(work) {
  const parts = [
    `风格：${getStyleLabel(work.styleCode)}`,
    `比例：${formatAspectRatio(work.aspectRatio)}`,
  ];

  if (work.durationSec) {
    parts.push(`时长：${work.durationSec} 秒`);
  }

  return `${parts.join(" · ")}。`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.message || "请求失败");
  }

  return body.data;
}

function updateMode() {
  const kind = new FormData(creationForm).get("kind");
  durationField.style.display = kind === "video" ? "grid" : "none";
}

function getKindLabel(kind) {
  return kindLabels[kind] || "作品";
}

function getStatusLabel(status) {
  return statusLabels[status] || "处理中";
}

function getStyleLabel(styleCode) {
  return styleLabels[styleCode] || "默认";
}

function renderUser(user) {
  userCard.innerHTML = `
    <div class="info-item">用户：${user.username}</div>
    <div class="info-item">可用额度：${user.credits.available}</div>
    <div class="info-item">冻结额度：${user.credits.frozen}</div>
    <div class="info-item">已消耗：${user.credits.used}</div>
  `;
}

function renderTasks(tasks) {
  if (!tasks.length) {
    taskFeed.className = "feed empty";
    taskFeed.textContent = "还没有任务";
    return;
  }

  taskFeed.className = "feed";
  taskFeed.innerHTML = tasks
    .slice(0, 6)
    .map(
      (task) => `
        <div class="feed-item">
          <div><strong>${getKindLabel(task.kind)}</strong> · ${getStatusLabel(task.status)}</div>
          <div>进度 ${task.progress}%</div>
        </div>
      `,
    )
    .join("");
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildMedia(asset) {
  if (!asset) {
    return `<div class="empty">无资源</div>`;
  }

  if (asset.mimeType.startsWith("video/")) {
    return `<video controls preload="metadata" src="${asset.url}"></video>`;
  }

  return `<img src="${asset.url}" alt="${escapeHtml(asset.title || "生成资源")}" />`;
}

function renderWorks(works) {
  if (!works.length) {
    worksGrid.className = "works-grid empty";
    worksGrid.textContent = "暂无作品";
    return;
  }

  worksGrid.className = "works-grid";
  worksGrid.innerHTML = "";

  for (const work of works) {
    const node = workCardTemplate.content.firstElementChild.cloneNode(true);
    const firstAsset = work.assets?.[0];
    node.querySelector(".work-media").innerHTML = buildMedia(firstAsset);
    node.querySelector(".work-title").textContent = buildWorkTitle(work);
    node.querySelector(".work-kind").textContent = getKindLabel(work.kind);
    node.querySelector(".work-prompt").textContent = buildWorkDescription(work);
    node.querySelector(".work-meta").innerHTML = `
      <span class="task-badge">${getStyleLabel(work.styleCode)}</span>
      <span class="task-badge">${formatAspectRatio(work.aspectRatio)}</span>
      ${work.durationSec ? `<span class="task-badge">${work.durationSec} 秒</span>` : ""}
      <span class="task-badge">${getStatusLabel(work.status)}</span>
    `;

    const openAsset = node.querySelector(".open-asset");
    openAsset.href = firstAsset?.url || "#";
    if (!firstAsset) {
      openAsset.style.pointerEvents = "none";
      openAsset.style.opacity = "0.5";
    }

    node.querySelector(".regenerate").addEventListener("click", async () => {
      await fetchJson(`/api/v1/works/${work.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await reload();
      startPolling();
    });

    worksGrid.appendChild(node);
  }
}

async function loadUser() {
  const user = await fetchJson("/api/v1/users/me");
  renderUser(user);
}

async function loadTasks() {
  const result = await fetchJson("/api/v1/tasks");
  renderTasks(result.items);
  const hasRunning = result.items.some((task) =>
    ["created", "queued", "running", "post_processing", "reviewing"].includes(task.status),
  );
  if (!hasRunning && pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

async function loadWorks() {
  const result = await fetchJson("/api/v1/works");
  renderWorks(result.items);
}

async function reload() {
  await Promise.all([loadUser(), loadTasks(), loadWorks()]);
}

function startPolling() {
  if (pollingTimer) {
    return;
  }

  pollingTimer = setInterval(async () => {
    try {
      await reload();
    } catch (error) {
      console.error(error);
    }
  }, 1500);
}

creationForm.addEventListener("change", updateMode);

creationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(creationForm);
  const kind = formData.get("kind");
  const payload = {
    prompt: formData.get("prompt"),
    styleCode: formData.get("styleCode"),
    aspectRatio: formData.get("aspectRatio"),
    durationSec: Number(formData.get("durationSec")),
  };

  const endpoint = kind === "video" ? "/api/v1/creations/videos" : "/api/v1/creations/images";
  try {
    await fetchJson(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    creationForm.reset();
    creationForm.querySelector('input[name="kind"][value="image"]').checked = true;
    updateMode();
    await reload();
    startPolling();
  } catch (error) {
    alert(error.message);
  }
});

refreshWorksButton.addEventListener("click", async () => {
  await reload();
});

updateMode();
await reload();
startPolling();
