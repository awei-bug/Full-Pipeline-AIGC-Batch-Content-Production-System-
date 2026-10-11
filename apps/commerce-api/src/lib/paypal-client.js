const DEFAULT_SANDBOX = "https://api-m.sandbox.paypal.com";
const DEFAULT_LIVE = "https://api-m.paypal.com";

export function resolvePaypalConfig(env = process.env) {
  const mode = String(env.PAYPAL_MODE || "mock").trim().toLowerCase();
  const clientId = String(env.PAYPAL_CLIENT_ID || "").trim();
  const clientSecret = String(env.PAYPAL_CLIENT_SECRET || "").trim();
  const configured = Boolean(clientId && clientSecret);
  const effectiveMode = mode === "live" || mode === "sandbox" ? mode : configured ? "sandbox" : "mock";

  return {
    mode: effectiveMode,
    configured: effectiveMode === "mock" ? true : configured,
    clientId,
    clientSecret,
    baseUrl: effectiveMode === "live" ? DEFAULT_LIVE : DEFAULT_SANDBOX,
    brandName: String(env.PAYPAL_BRAND_NAME || "Independent Store SaaS").trim(),
    webhookId: String(env.PAYPAL_WEBHOOK_ID || "").trim() || null,
  };
}

export function createPaypalClient(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const config = resolvePaypalConfig(env);
  let cachedToken = null;
  let cachedTokenExpiresAt = 0;

  async function getAccessToken() {
    if (config.mode === "mock") {
      return "mock-access-token";
    }
    if (!config.configured) {
      const error = new Error("PayPal is not configured");
      error.code = "PAYPAL_NOT_CONFIGURED";
      throw error;
    }
    if (cachedToken && Date.now() < cachedTokenExpiresAt) {
      return cachedToken;
    }

    const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const response = await fetchImpl(`${config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error_description || payload.message || "PayPal auth failed");
      error.code = "PAYPAL_AUTH_FAILED";
      throw error;
    }
    cachedToken = payload.access_token;
    cachedTokenExpiresAt = Date.now() + Math.max(30, Number(payload.expires_in || 300) - 30) * 1000;
    return cachedToken;
  }

  async function api(path, { method = "GET", body } = {}) {
    if (config.mode === "mock") {
      return mockApi(path, { method, body });
    }

    const token = await getAccessToken();
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        payload?.message ||
        payload?.details?.[0]?.description ||
        payload?.error_description ||
        `PayPal request failed (${response.status})`;
      const error = new Error(message);
      error.code = "PAYPAL_API_ERROR";
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function mockApi(path, { method, body }) {
    if (path === "/v2/checkout/orders" && method === "POST") {
      const customId = body?.purchase_units?.[0]?.custom_id || "order_mock";
      const id = `PAYPALMOCK${Date.now().toString(36).toUpperCase()}`;
      const returnUrl = body?.application_context?.return_url || "http://127.0.0.1:3000/";
      return {
        id,
        status: "CREATED",
        links: [
          {
            rel: "approve",
            href: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}token=${id}&PayerID=MOCKPAYER&mock=1`,
            method: "GET",
          },
          { rel: "self", href: `${config.baseUrl}/v2/checkout/orders/${id}`, method: "GET" },
        ],
        purchase_units: [{ custom_id: customId }],
      };
    }

    if (path.startsWith("/v2/checkout/orders/") && path.endsWith("/capture") && method === "POST") {
      const id = path.split("/")[3];
      return {
        id,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              captures: [{ id: `CAP${id.slice(-8)}`, status: "COMPLETED" }],
            },
          },
        ],
      };
    }

    if (path.startsWith("/v2/checkout/orders/") && method === "GET") {
      const id = path.split("/")[3];
      return { id, status: "APPROVED" };
    }

    return { ok: true };
  }

  return {
    config,
    async createOrder({
      orderId,
      orderNo,
      amountCents,
      currency = "USD",
      returnUrl,
      cancelUrl,
      brandName,
    }) {
      const value = (Number(amountCents || 0) / 100).toFixed(2);
      const payload = await api("/v2/checkout/orders", {
        method: "POST",
        body: {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: orderNo || orderId,
              custom_id: orderId,
              description: `Order ${orderNo || orderId}`,
              amount: {
                currency_code: String(currency || "USD").toUpperCase(),
                value,
              },
            },
          ],
          application_context: {
            brand_name: brandName || config.brandName,
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      });

      const approveUrl = (payload.links || []).find((link) => link.rel === "approve")?.href || null;
      return {
        paypalOrderId: payload.id,
        status: payload.status,
        approveUrl,
        raw: payload,
      };
    },

    async captureOrder(paypalOrderId) {
      const payload = await api(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
        method: "POST",
        body: {},
      });
      const captureId =
        payload?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
        payload?.id ||
        null;
      return {
        paypalOrderId: payload.id || paypalOrderId,
        status: payload.status,
        captureId,
        raw: payload,
      };
    },

    async getOrder(paypalOrderId) {
      const payload = await api(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
        method: "GET",
      });
      return payload;
    },
  };
}
