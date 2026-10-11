const DEFAULT_TIMEOUT_MS = 20000;

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function hasAiOrchestratorConfig(env = process.env) {
  return Boolean(normalizeBaseUrl(env.AI_ORCHESTRATOR_BASE_URL));
}

export function buildLocalProductCopy(product = {}) {
  const name = String(product.title || product.name || "Export Product").trim();
  const description = String(product.description || "").trim();
  const sellingPoint =
    description.split(/[\n.!?]/).map((part) => part.trim()).filter(Boolean)[0] ||
    "Reliable quality for overseas buyers";
  const audience = String(product.audience || product.targetMarket || "global B2B buyers").trim();
  const category = String(product.category || "general merchandise").trim();

  return {
    title: `${name} for ${audience}`,
    description: [
      `${name} is designed for ${audience}.`,
      `Key advantage: ${sellingPoint}.`,
      `Category: ${category}.`,
      "Contact us for MOQ, lead time, and FOB pricing.",
    ].join(" "),
    sellingPoints: [sellingPoint, `Suitable for ${audience}`, `Category: ${category}`],
    generationMeta: {
      source: "local_fallback",
      fallbackUsed: true,
      reason: "orchestrator_unavailable",
    },
  };
}

export function createAiOrchestratorClient(
  env = process.env,
  { fetchImpl = globalThis.fetch } = {},
) {
  const baseUrl = normalizeBaseUrl(env.AI_ORCHESTRATOR_BASE_URL);
  if (!baseUrl || typeof fetchImpl !== "function") {
    return {
      mode: "local_fallback",
      baseUrl: null,
      async generateProductCopy(product) {
        return buildLocalProductCopy(product);
      },
    };
  }

  const timeoutMs = Number(env.AI_ORCHESTRATOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  return {
    mode: "http",
    baseUrl,
    async generateProductCopy(product) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/internal/commerce/product-copy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product }),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.message || `AI orchestrator error (${response.status})`);
        }
        return payload?.data || buildLocalProductCopy(product);
      } catch (error) {
        if (error?.name === "AbortError") {
          return {
            ...buildLocalProductCopy(product),
            generationMeta: {
              source: "local_fallback",
              fallbackUsed: true,
              reason: "orchestrator_timeout",
            },
          };
        }
        return {
          ...buildLocalProductCopy(product),
          generationMeta: {
            source: "local_fallback",
            fallbackUsed: true,
            reason: error.message || "orchestrator_error",
          },
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
