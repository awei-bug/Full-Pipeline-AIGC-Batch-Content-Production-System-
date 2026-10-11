const DEFAULT_TIMEOUT_MS = 10000;

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildErrorMessage(status, payload) {
  if (payload && typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }
  if (payload && typeof payload.detail === "string" && payload.detail.trim()) {
    return payload.detail.trim();
  }
  if (Array.isArray(payload?.detail) && payload.detail.length) {
    const issue = payload.detail[0];
    const field = Array.isArray(issue?.loc) ? issue.loc.filter((part) => part !== "body").join(".") : "参数";
    return `${field || "参数"}：${issue?.msg || "格式不正确"}`;
  }

  return `编排服务响应异常，状态码 ${status}`;
}

function buildHttpError(status, payload) {
  const error = new Error(buildErrorMessage(status, payload));
  error.statusCode = status;
  error.code = payload?.code || "ORCHESTRATOR_UPSTREAM_ERROR";
  return error;
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
    async ipRequest(path, { method = "GET", body } = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/internal/ip-content${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok) throw buildHttpError(response.status, payload);
        return payload.data;
      } catch (error) {
        if (error?.name === "AbortError") throw new Error("IP 内容服务请求超时");
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    async chat(payload) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(`${baseUrl}/internal/chat`, {
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
          throw buildHttpError(response.status, responsePayload);
        }

        return responsePayload?.data || {};
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new Error("对话服务请求超时");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    async submitContentWorkflow(payload) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(`${baseUrl}/internal/content-workflows`, {
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
          throw buildHttpError(response.status, responsePayload);
        }
        return responsePayload?.data || {};
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new Error("内容工作流启动超时");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    async getContentWorkflow(workflowId) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(
          `${baseUrl}/internal/content-workflows/${encodeURIComponent(workflowId)}`,
          { signal: controller.signal },
        );
        const responseText = await response.text();
        const responsePayload = responseText ? JSON.parse(responseText) : null;
        if (!response.ok) {
          throw buildHttpError(response.status, responsePayload);
        }
        return responsePayload?.data || {};
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new Error("内容工作流状态查询超时");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
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
          throw buildHttpError(response.status, responsePayload);
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
          throw buildHttpError(response.status, responsePayload);
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
