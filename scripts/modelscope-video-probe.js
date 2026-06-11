import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://api-inference.modelscope.cn/v1";
const DEFAULT_MODELS = [
  "Wan-AI/Wan2.1-T2V-1.3B",
  "AI-ModelScope/stepvideo-t2v-turbo",
  "AI-ModelScope/CogVideoX-5b",
  "AI-ModelScope/HunyuanVideo",
];
const DEFAULT_DATA_INSPECTION = '{"input":false,"output":false}';
const RUNNING_STATUSES = new Set(["PROCESSING", "PENDING", "RUNNING"]);
const SUCCESS_STATUSES = new Set(["SUCCEED", "SUCCESS", "COMPLETED"]);
const FAILED_STATUSES = new Set(["FAILED", "FAIL", "CANCELED", "CANCELLED"]);

export function parseCsvList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function extractTaskId(payload) {
  return (
    payload?.task_id ||
    payload?.output?.task_id ||
    payload?.output?.taskId ||
    null
  );
}

export function extractVideoUrl(payload) {
  const candidates = [
    payload?.output_video,
    payload?.output?.output_video,
    payload?.output?.video_url,
    payload?.video_url,
    payload?.output?.video,
    payload?.video,
    payload?.output?.result_url,
    payload?.result_url,
    payload?.output_videos?.[0],
    payload?.output?.output_videos?.[0],
    payload?.output?.videos?.[0],
    payload?.videos?.[0],
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
    if (candidate && typeof candidate === "object" && candidate.url) {
      return String(candidate.url);
    }
  }

  return null;
}

function extractTaskStatus(payload) {
  return (
    payload?.task_status ||
    payload?.output?.task_status ||
    payload?.status ||
    payload?.output?.status ||
    null
  );
}

function extractErrorMessage(payload, fallback) {
  return (
    payload?.message ||
    payload?.errors?.message ||
    payload?.error?.message ||
    payload?.output?.message ||
    payload?.output?.error_message ||
    payload?.raw ||
    fallback
  );
}

export function summarizeProbeResults(results) {
  const succeeded = results.find((item) => item.status === "succeeded");
  const accepted = results.find((item) => item.status === "running_timeout" || item.status === "accepted");
  const recommended = succeeded || accepted || null;

  return {
    recommendedModel: recommended?.model || null,
    hasSucceededModel: Boolean(succeeded),
    hasAcceptedModel: Boolean(accepted),
    results,
  };
}

function readEnvValue(name) {
  return process.env[name] || "";
}

function parseArgs(argv) {
  const options = {
    baseUrl: readEnvValue("MODELSCOPE_BASE_URL") || DEFAULT_BASE_URL,
    dataInspection: readEnvValue("MODELSCOPE_DATA_INSPECTION") || DEFAULT_DATA_INSPECTION,
    models: DEFAULT_MODELS,
    pollSeconds: 180,
    pollIntervalSeconds: 10,
    createTimeoutMs: 60000,
    prompt: "Create a short cinematic night city shot with smooth motion and a clear focal subject.",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--models" && next) {
      options.models = parseCsvList(next);
      index += 1;
    } else if (arg === "--prompt" && next) {
      options.prompt = next;
      index += 1;
    } else if (arg === "--poll-seconds" && next) {
      options.pollSeconds = Number(next);
      index += 1;
    } else if (arg === "--poll-interval-seconds" && next) {
      options.pollIntervalSeconds = Number(next);
      index += 1;
    } else if (arg === "--base-url" && next) {
      options.baseUrl = next;
      index += 1;
    } else if (arg === "--data-inspection" && next) {
      options.dataInspection = next;
      index += 1;
    }
  }

  options.baseUrl = String(options.baseUrl).replace(/\/+$/, "");
  return options;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return {
    ok: response.ok,
    statusCode: response.status,
    payload,
  };
}

async function createVideoTask({ model, options, token }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.createTimeoutMs);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-ModelScope-Async-Mode": "true",
  };

  if (options.dataInspection && options.dataInspection !== "omit") {
    headers["X-ModelScope-DataInspection"] = options.dataInspection;
  }

  try {
    const response = await fetchJson(`${options.baseUrl}/videos/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        prompt: options.prompt,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        model,
        status: "create_failed",
        statusCode: response.statusCode,
        message: extractErrorMessage(response.payload, "create request failed"),
        raw: response.payload,
      };
    }

    const taskId = extractTaskId(response.payload);
    if (!taskId) {
      return {
        model,
        status: "create_failed",
        statusCode: response.statusCode,
        message: "create response did not include task_id",
        raw: response.payload,
      };
    }

    return {
      model,
      status: "accepted",
      taskId,
      raw: response.payload,
    };
  } catch (error) {
    return {
      model,
      status: "create_failed",
      message: error?.name === "AbortError" ? "create request timeout" : String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollVideoTask({ model, taskId, options, token }) {
  const startedAt = Date.now();
  let lastPayload = null;
  let lastStatus = null;

  while (Date.now() - startedAt < options.pollSeconds * 1000) {
    await sleep(options.pollIntervalSeconds * 1000);

    const response = await fetchJson(`${options.baseUrl}/tasks/${taskId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-ModelScope-Task-Type": "video_generation",
      },
    });

    lastPayload = response.payload;
    if (!response.ok) {
      return {
        model,
        status: "poll_failed",
        taskId,
        statusCode: response.statusCode,
        message: extractErrorMessage(response.payload, "poll request failed"),
        raw: response.payload,
      };
    }

    lastStatus = extractTaskStatus(response.payload);
    if (SUCCESS_STATUSES.has(lastStatus)) {
      return {
        model,
        status: "succeeded",
        taskId,
        taskStatus: lastStatus,
        videoUrl: extractVideoUrl(response.payload),
        raw: response.payload,
      };
    }

    if (FAILED_STATUSES.has(lastStatus)) {
      return {
        model,
        status: "failed",
        taskId,
        taskStatus: lastStatus,
        message: extractErrorMessage(response.payload, "model task failed"),
        raw: response.payload,
      };
    }

    if (!RUNNING_STATUSES.has(lastStatus)) {
      return {
        model,
        status: "unknown_task_status",
        taskId,
        taskStatus: lastStatus,
        raw: response.payload,
      };
    }
  }

  return {
    model,
    status: "running_timeout",
    taskId,
    taskStatus: lastStatus,
    raw: lastPayload,
  };
}

async function probeModel({ model, options, token }) {
  const created = await createVideoTask({ model, options, token });
  if (created.status !== "accepted") {
    return created;
  }

  if (options.pollSeconds <= 0) {
    return created;
  }

  return pollVideoTask({
    model,
    taskId: created.taskId,
    options,
    token,
  });
}

async function main() {
  const token = readEnvValue("MODELSCOPE_API_TOKEN");
  if (!token) {
    throw new Error("MODELSCOPE_API_TOKEN is required.");
  }

  const options = parseArgs(process.argv.slice(2));
  const results = [];
  for (const model of options.models) {
    process.stderr.write(`Probing ${model}...\n`);
    results.push(await probeModel({ model, options, token }));
  }

  const summary = summarizeProbeResults(results);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.recommendedModel) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
