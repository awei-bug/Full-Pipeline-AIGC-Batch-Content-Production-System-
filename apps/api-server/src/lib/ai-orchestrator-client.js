const DEFAULT_TIMEOUT_MS = 10000;

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildErrorMessage(status, payload) {
  if (payload && typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }

  return `编排服务响应异常，状态码 ${status}`;
}

export function hasAiOrchestratorConfig(env = process.env) {
  return Boolean(normalizeBaseUrl(env.AI_ORCHESTRATOR_BASE_URL));
}

export function createAiOrchestratorClient(
  env = process.env,
  { fetchImpl = globalThis.fetch } = {},
) {
  const baseUrl = normalizeBaseUrl(env.AI_ORCHESTRATOR_BASE_URL);
  if (!baseUrl || typeof fetchImpl !== "function") {
    return null;
  }

  const timeoutMs = Number(env.AI_ORCHESTRATOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  return {
    mode: "http",
    baseUrl,
    async startGeneration(payload) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(`${baseUrl}/internal/workflows/generate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        const responseText = await response.text();
        const responsePayload = responseText ? JSON.parse(responseText) : null;

        if (!response.ok) {
          throw new Error(buildErrorMessage(response.status, responsePayload));
        }

        return responsePayload?.data || {};
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new Error("编排服务请求超时");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    async submitBatchItem(payload) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(`${baseUrl}/internal/batch-jobs/items`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        const responseText = await response.text();
        const responsePayload = responseText ? JSON.parse(responseText) : null;

        if (!response.ok) {
          throw new Error(buildErrorMessage(response.status, responsePayload));
        }

        return responsePayload?.data || {};
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new Error("编排服务批任务请求超时");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
