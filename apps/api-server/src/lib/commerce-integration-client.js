const DEFAULT_TIMEOUT_MS = 60000;

export function hasCommerceIntegrationConfig(env = process.env) {
  return Boolean(
    String(env.COMMERCE_IMPORT_URL || "").trim() &&
      String(env.COMMERCE_IMPORT_TOKEN || "").trim() &&
      String(env.COMMERCE_TENANT_SLUG || "").trim(),
  );
}

export function buildCommerceIntegrationConfig(env = process.env) {
  return {
    importUrl: String(env.COMMERCE_IMPORT_URL || "").trim(),
    token: String(env.COMMERCE_IMPORT_TOKEN || "").trim(),
    tenantSlug: String(env.COMMERCE_TENANT_SLUG || "").trim(),
    timeoutMs: Number(env.COMMERCE_IMPORT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };
}

export function createCommerceIntegrationClient(env = process.env) {
  if (!hasCommerceIntegrationConfig(env)) {
    return null;
  }

  const config = buildCommerceIntegrationConfig(env);

  return {
    config,
    get target() {
      return {
        importUrl: config.importUrl,
        tenantSlug: config.tenantSlug,
      };
    },

    async pushListingPack({ buffer, fileName }) {
      if (!buffer || buffer.length === 0) {
        throw new Error("成品包内容为空");
      }

      const formData = new FormData();
      formData.append(
        "file",
        new Blob([buffer], { type: "application/zip" }),
        fileName || "listing-pack.zip",
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);

      try {
        const response = await fetch(config.importUrl, {
          method: "POST",
          headers: {
            "X-Integration-Token": config.token,
            "X-Tenant-Slug": config.tenantSlug,
          },
          body: formData,
          signal: controller.signal,
        });

        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          const error = new Error(
            payload?.msg || payload?.message || `商城返回状态码 ${response.status}`,
          );
          error.statusCode = response.status >= 400 && response.status <= 599 ? response.status : 502;
          throw error;
        }

        return payload?.data || payload || {};
      } catch (error) {
        if (error?.name === "AbortError") {
          const timeoutError = new Error(`推送超时（超过 ${config.timeoutMs} 毫秒）`);
          timeoutError.statusCode = 504;
          throw timeoutError;
        }
        if (!error?.statusCode) {
          error.statusCode = 502;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
