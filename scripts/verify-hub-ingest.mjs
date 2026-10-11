import { buildApp } from "../apps/api-server/src/server.js";

const HUB_URL = process.env.DATA_HUB_URL || "http://127.0.0.1:8120";
const TENANT = process.env.DATA_HUB_TENANT_SLUG || "demo";
const TOKEN = process.env.DATA_HUB_TOKEN || "";

const env = {
  ...process.env,
  DATABASE_URL: "",
  PGHOST: "",
  POSTGRES_HOST: "",
  DATA_HUB_URL: HUB_URL,
  DATA_HUB_TENANT_SLUG: TENANT,
  DATA_HUB_TOKEN: TOKEN,
};

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

const app = await buildApp({ env });
const svc = app.locals.dataHubSyncService;
const batches = app.locals.importBatchesRepository;
const jobs = app.locals.contentJobsRepository;

check("service.ready", Boolean(svc));
if (!svc) {
  process.exit(1);
}

const batch = await batches.createImportBatch({
  fileName: "verify-hub.csv",
  fieldMapping: { name: "name" },
});

const products = await batches.createProducts([
  {
    batchId: batch.id,
    sourceRowNo: 1,
    originalData: { name: "不锈钢真空保温杯" },
    normalizedData: {
      name: "不锈钢真空保温杯",
      sellingPoint: "双层真空；24小时保温；食品级材质",
      price: "FOB $2.8 / MOQ 500",
      category: "日用百货",
      scenario: "礼品与商超渠道",
      tags: ["保温杯", "不锈钢"],
      spec: { 容量: "500ml" },
      faq: [{ q: "能保温多久", a: "24 小时" }],
    },
  },
]);

const job = await jobs.createJob({
  batchId: batch.id,
  contentTypes: ["marketing_copy", "image_asset"],
});

const jobItems = await jobs.createJobItems(
  products.map((p) => ({ jobId: job.id, productId: p.id, status: "pending" })),
);

await jobs.createOutputs(jobItems[0].id, [
  { outputType: "marketing_copy", outputData: { title: "Vacuum Insulated Stainless Steel Bottle 500ml" } },
  {
    outputType: "image_asset",
    outputData: {
      assetType: "image",
      storageProvider: "local",
      objectKey: "generated/verify.png",
      fileName: "verify.png",
      metadata: { publicUrl: "/storage/assets/verify.png" },
    },
  },
]);

const result = await svc.ingestJobContent({ jobId: job.id });
check("ingest.ok", result.hub.okCount === 1, JSON.stringify(result.hub.created !== undefined
  ? { created: result.hub.created, updated: result.hub.updated, unchanged: result.hub.unchanged }
  : result.hub));

const externalId = result.items?.[0]?.external_id;
check("ingest.external_id", Boolean(externalId), String(externalId));
check("ingest.points", (result.items?.[0]?.selling_points || []).length >= 3,
  JSON.stringify(result.items?.[0]?.selling_points));
check("ingest.faq", (result.items?.[0]?.faq || []).length === 1, JSON.stringify(result.items?.[0]?.faq));
check("ingest.desc_en", Boolean(result.items?.[0]?.desc_en), String(result.items?.[0]?.desc_en).slice(0, 40));

const again = await svc.ingestJobContent({ jobId: job.id });
check("ingest.idempotent", again.hub.unchanged === 1, JSON.stringify({
  created: again.hub.created, updated: again.hub.updated, unchanged: again.hub.unchanged,
}));

const resp = await fetch(`${HUB_URL}/hub/products/${TENANT}/${encodeURIComponent(externalId)}`, {
  headers: { "X-Hub-Tenant": TENANT, ...(TOKEN ? { "X-Hub-Token": TOKEN } : {}) },
});
const payload = await resp.json();
check("hub.persisted", Boolean(payload?.ok && payload.item), payload?.item?.title || "");
check("hub.category", payload?.item?.category === "日用百货", String(payload?.item?.category));

const searchResp = await fetch(`${HUB_URL}/hub/search`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Tenant": TENANT,
    ...(TOKEN ? { "X-Hub-Token": TOKEN } : {}),
  },
  body: JSON.stringify({ tenant_slug: TENANT, query: "保温杯 能保温多久", limit: 3, published_only: false }),
});
const searchPayload = await searchResp.json();
check("hub.search", (searchPayload?.cards || []).length > 0, String(searchPayload?.count));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
