import * as XLSX from "xlsx";

const apiBaseUrl =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL) ||
  "http://127.0.0.1:3100";

export { apiBaseUrl };

async function request(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || "请求失败");
  }

  return payload.data;
}

async function requestBlob(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...(options || {}),
  });

  if (!response.ok) {
    let message = "请求失败";
    try {
      const payload = await response.json();
      message = payload.message || message;
    } catch {
      // ignore invalid json body
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  return {
    blob,
    fileName: decodeURIComponent(
      (response.headers.get("content-disposition") || "")
        .match(/filename\*=UTF-8''([^;]+)/i)?.[1] || "批量内容结果.xlsx",
    ),
  };
}

export function parseCsvText(csvText) {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("至少需要一行表头和一行商品数据。");
  }

  const headers = lines[0].split(",").map((item) => item.trim());
  const rows = lines.slice(1).map((line) => {
    const values = line.split(",").map((item) => item.trim());
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

  const normalizedName = String(file.name || "products.csv").trim() || "products.csv";
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
      throw new Error("导入文件中没有可用的商品数据。");
    }
    return {
      ...result,
      fileName: normalizedName,
    };
  }

  throw new Error("仅支持上传 CSV、XLSX 或 XLS 文件。");
}

export function buildFieldMapping(headers) {
  const list = Array.isArray(headers) ? headers : [];
  const findHeader = (patterns) =>
    list.find((header) => patterns.some((pattern) => header.toLowerCase().includes(pattern))) ||
    list[0] ||
    "";

  return {
    name: findHeader(["name", "title", "商品", "名称"]),
    sellingPoint: findHeader(["selling", "highlight", "卖点", "亮点"]),
    price: findHeader(["price", "售价", "价格"]),
    category: findHeader(["category", "类目", "分类"]),
    audience: findHeader(["audience", "人群", "客群"]),
    scenario: findHeader(["scenario", "scene", "场景"]),
  };
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
