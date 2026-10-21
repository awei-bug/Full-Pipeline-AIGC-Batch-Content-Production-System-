import * as XLSX from "xlsx";

import { readToken, clearSession } from "./session.js";

const apiBaseUrl =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL) ||
  "http://127.0.0.1:3100";

export { apiBaseUrl };

const DEFAULT_EXPORT_FILE_NAME = "外贸内容结果.xlsx";

/**
 * 带鉴权头的请求。
 *
 * 401 与 403 必须分开处理：
 * - 401 = 未登录 / token 过期 → 清掉本地 token，提示重新登录；
 * - 403 = 已登录但角色不足 → **绝不能清 token**，否则用户会莫名其妙被登出，
 *   而且再登录一次结果一样，问题定位会跑偏。
 *
 * `AUTH_MODE=off` 时后端忽略这个头，前端也可以在无 token 时正常请求，
 * 所以这里不做"没有 token 就不发请求"的前置拦截。
 */
async function request(path, options = {}) {
  const token = readToken();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const payload = await response.json();

  if (response.status === 401) {
    clearSession();
    throw Object.assign(new Error(payload.message || "登录已失效，请重新登录"), {
      statusCode: 401,
      code: payload.code,
    });
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload.message || "请求失败"), {
      statusCode: response.status,
      code: payload.code,
    });
  }

  return payload.data;
}

async function requestBlob(path, options = {}) {
  const token = readToken();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...(options || {}),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...((options && options.headers) || {}),
    },
  });

  if (response.status === 401) {
    clearSession();
  }

  if (!response.ok) {
    let message = "请求失败";
    try {
      const payload = await response.json();
      message = payload.message || message;
    } catch {
      // ignore invalid json body
    }
    throw Object.assign(new Error(message), { statusCode: response.status });
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const fileName =
    decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || "") ||
    disposition.match(/filename="([^"]+)"/i)?.[1] ||
    DEFAULT_EXPORT_FILE_NAME;
  return { blob, fileName };
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

export function parseCsvText(csvText) {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("至少需要一行表头和一行产品数据。");
  }

  const headers = parseCsvLine(lines[0]).map((item) => item.trim()).filter(Boolean);
  if (headers.length === 0) {
    throw new Error("CSV 表头不能为空。");
  }

  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((result, header, index) => {
      result[header] = values[index] ?? "";
      return result;
    }, {});
  });

  return {
    headers,
    rows,
  };
}

function normalizeSheetRows(rows) {
  const normalizedRows = (Array.isArray(rows) ? rows : []).filter((row) =>
    row && Object.values(row).some((value) => String(value ?? "").trim() !== ""),
  );
  const headers = normalizedRows.length > 0 ? Object.keys(normalizedRows[0]) : [];
  return {
    headers,
    rows: normalizedRows,
  };
}

export async function parseImportFile(file) {
  if (!(file instanceof File)) {
    throw new Error("请先选择需要导入的文件。");
  }

  const normalizedName = String(file.name || "export-products.csv").trim() || "export-products.csv";
  const fileExtension = normalizedName.split(".").pop()?.toLowerCase() || "";

  if (fileExtension === "csv") {
    const text = await file.text();
    const result = parseCsvText(text);
    return {
      ...result,
      fileName: normalizedName,
    };
  }

  if (fileExtension === "xlsx" || fileExtension === "xls") {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new Error("Excel 文件中没有可读取的数据表。");
    }
    const worksheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      defval: "",
    });
    const result = normalizeSheetRows(rows);
    if (result.rows.length === 0) {
      throw new Error("导入文件中没有可用的产品数据。");
    }
    return {
      ...result,
      fileName: normalizedName,
    };
  }

  throw new Error("仅支持上传 CSV、XLSX 或 XLS 文件。");
}

export function buildFieldMapping(headers) {
  const list = Array.isArray(headers) ? headers.map((item) => String(item || "").trim()) : [];
  const used = new Set();

  const findHeader = (patterns) => {
    const match = list.find((header) => {
      if (used.has(header)) {
        return false;
      }
      const lower = header.toLowerCase();
      return patterns.some((pattern) => lower.includes(String(pattern).toLowerCase()));
    });
    if (match) {
      used.add(match);
      return match;
    }
    return "";
  };

  const mapping = {
    name: findHeader(["name", "title", "product", "sku", "商品", "名称", "产品"]),
    sellingPoint: findHeader(["selling", "highlight", "advantage", "feature", "卖点", "亮点", "优势"]),
    price: findHeader(["price", "fob", "moq", "售价", "价格", "报价"]),
    category: findHeader(["category", "hs", "industry", "类目", "分类", "品类"]),
    audience: findHeader(["audience", "market", "country", "region", "人群", "市场", "国家"]),
    scenario: findHeader(["scenario", "scene", "application", "use", "场景", "用途", "应用"]),
  };

  if (!mapping.name) {
    throw new Error("未能识别产品名称字段，请检查表头是否包含名称/产品/Name。");
  }

  return mapping;
}

export async function sendChatMessage(messages) {
  return request("/api/chat", {
    method: "POST",
    body: JSON.stringify({ messages }),
  });
}

export async function startContentWorkflow(payload) {
  return request("/api/content-workflows", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getContentWorkflow(workflowId) {
  return request(`/api/content-workflows/${encodeURIComponent(workflowId)}`);
}

export async function listImportBatches() {
  const result = await request("/api/import-batches");
  return result.items || [];
}

export async function createImportBatch({ fileName, rows, fieldMapping }) {
  return request("/api/import-batches", {
    method: "POST",
    body: JSON.stringify({
      fileName,
      rows,
      fieldMapping,
    }),
  });
}

export async function listProducts(batchId) {
  const result = await request(`/api/products?batchId=${encodeURIComponent(batchId)}`);
  return result.items || [];
}

export async function listContentJobs() {
  const result = await request("/api/content-jobs");
  return result.items || [];
}

export async function createContentJob({ batchId, contentTypes }) {
  return request("/api/content-jobs", {
    method: "POST",
    body: JSON.stringify({
      batchId,
      contentTypes,
    }),
  });
}

export async function listContentOutputs(jobId) {
  const result = await request(`/api/content-outputs?jobId=${encodeURIComponent(jobId)}`);
  return result.items || [];
}

export async function exportContentJob(jobId) {
  return requestBlob(`/api/content-exports/${encodeURIComponent(jobId)}`);
}

export async function previewListingPack(jobId) {
  return request(`/api/listing-packs/${encodeURIComponent(jobId)}/preview`);
}

export async function pushListingPack(jobId, { prices = {}, publish = false } = {}) {
  return request(`/api/listing-packs/${encodeURIComponent(jobId)}/push`, {
    method: "POST",
    body: JSON.stringify({ prices, publish }),
  });
}

export async function downloadListingPack(jobId, { prices = {}, publish = false } = {}) {
  return requestBlob(`/api/listing-packs/${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prices, publish }),
  });
}
