const DEFAULT_TIMEOUT_MS = 20000;

export function hasDataHubConfig(env = process.env) {
  return Boolean(
    String(env.DATA_HUB_URL || "").trim() &&
      String(env.DATA_HUB_TENANT_SLUG || "").trim(),
  );
}

export function buildDataHubConfig(env = process.env) {
  return {
    baseUrl: String(env.DATA_HUB_URL || "").trim().replace(/\/+$/, ""),
    token: String(env.DATA_HUB_TOKEN || "").trim(),
    tenantSlug: String(env.DATA_HUB_TENANT_SLUG || "").trim(),
    timeoutMs: Number(env.DATA_HUB_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };
}

export function createDataHubClient(env = process.env) {
  if (!hasDataHubConfig(env)) {
    return null;
  }

  const config = buildDataHubConfig(env);

  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Tenant": config.tenantSlug,
          ...(config.token ? { "X-Hub-Token": config.token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const error = new Error(
          payload?.error || payload?.message || `数据中心返回状态码 ${response.status}`,
        );
        error.statusCode = response.status >= 400 && response.status <= 599 ? response.status : 502;
        throw error;
      }

      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    config,
    mode: "http",
    get target() {
      return { baseUrl: config.baseUrl, tenantSlug: config.tenantSlug };
    },

    async health() {
      return request("GET", "/health");
    },

    async ingest({ items, jobId = "", source = "content_create" }) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("数据中心同步内容为空");
      }
      return request("POST", "/hub/ingest", {
        tenant_slug: config.tenantSlug,
        source,
        job_id: jobId,
        items,
      });
    },

    async ack({ externalId, productId, status = "published" }) {
      if (!externalId) {
        throw new Error("缺少 externalId");
      }
      return request(
        "POST",
        `/hub/products/${encodeURIComponent(config.tenantSlug)}/${encodeURIComponent(externalId)}/ack`,
        { product_id: productId, status },
      );
    },

    async search({ query, limit = 5, publishedOnly = false }) {
      return request("POST", "/hub/search", {
        tenant_slug: config.tenantSlug,
        query,
        limit,
        published_only: publishedOnly,
      });
    },

    async listProducts({ status = "", limit = 50, since = "" } = {}) {
      const params = new URLSearchParams();
      params.set("tenant", config.tenantSlug);
      if (status) params.set("status", status);
      if (since) params.set("since", since);
      params.set("limit", String(limit));
      return request("GET", `/hub/products?${params.toString()}`);
    },

    async stats() {
      const params = new URLSearchParams();
      params.set("tenant", config.tenantSlug);
      return request("GET", `/hub/stats?${params.toString()}`);
    },
  };
}
