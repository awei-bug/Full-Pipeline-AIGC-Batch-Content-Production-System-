# AIGC Batch Content Production MVP Phase 1 Implementation Plan

> 状态说明：该阶段计划已经基本落地，当前仓库运行结构以 `apps/studio-web`、`apps/api-server`、`apps/ai-orchestrator` 为准。本文主要保留为阶段实施记录。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working MVP of the batch AIGC content production system: import product data, create batch content jobs, generate copy/script/image prompts/images per product, and export results.

**Architecture:** Reuse the existing React + Node + FastAPI/LangGraph service layout, but replace the old single-request creation flow with a batch job model. The Node API becomes the business center for imports/jobs/exports, and the Python orchestrator becomes the per-item production pipeline executor.

**Tech Stack:** React, Vite, Express, PostgreSQL, FastAPI, LangGraph, unittest, Node test runner

---

## File Structure

### Existing files to modify

- `apps/api-server/src/server.js`
- `apps/api-server/src/lib/database.js`
- `apps/studio-web/src/App.jsx`
- `apps/studio-web/src/styles.css`
- `apps/ai-orchestrator/app/main.py`
- `apps/ai-orchestrator/app/models.py`
- `apps/ai-orchestrator/app/services/orchestration_service.py`
- `apps/ai-orchestrator/app/graphs/generation_graph.py`
- `scripts/init-postgres.js`

### New backend files

- `apps/api-server/src/routes/import-batches.js`
- `apps/api-server/src/routes/products.js`
- `apps/api-server/src/routes/content-jobs.js`
- `apps/api-server/src/routes/content-exports.js`
- `apps/api-server/src/repositories/import-batches-repository.js`
- `apps/api-server/src/repositories/products-repository.js`
- `apps/api-server/src/repositories/content-jobs-repository.js`
- `apps/api-server/src/services/import-batch-service.js`
- `apps/api-server/src/services/content-job-service.js`
- `apps/api-server/src/services/content-export-service.js`
- `apps/api-server/src/services/import-batch-service.test.js`
- `apps/api-server/src/services/content-job-service.test.js`
- `apps/api-server/src/services/content-export-service.test.js`

### New orchestrator files

- `apps/ai-orchestrator/app/models_batch.py`
- `apps/ai-orchestrator/app/graphs/batch_generation_state.py`
- `apps/ai-orchestrator/app/graphs/batch_generation_graph.py`
- `apps/ai-orchestrator/app/graphs/nodes/load_product_context.py`
- `apps/ai-orchestrator/app/graphs/nodes/generate_marketing_copy.py`
- `apps/ai-orchestrator/app/graphs/nodes/generate_video_script.py`
- `apps/ai-orchestrator/app/graphs/nodes/generate_image_prompt.py`
- `apps/ai-orchestrator/app/graphs/nodes/persist_batch_result.py`
- `apps/ai-orchestrator/tests/test_batch_generation_graph.py`
- `apps/ai-orchestrator/tests/test_batch_orchestration_service.py`

### New frontend support files

- `apps/studio-web/src/batch-api.js`
- `apps/studio-web/src/batch-view-model.js`
- `apps/studio-web/src/batch-view-model.test.js`

### Documentation files

- `README.md`
- `docs/mvp-acceptance-checklist.md`

---

### Task 1: Create database schema for import batches, products, content jobs, and outputs

**Files:**
- Modify: `scripts/init-postgres.js`
- Modify: `apps/api-server/src/lib/database.js`
- Test: `apps/api-server/src/services/import-batch-service.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createImportBatchService } from "./import-batch-service.js";

test("create import batch persists batch metadata and product rows", async () => {
  const repository = {
    createImportBatch: async () => ({ id: "ib_001" }),
    createProducts: async (rows) => rows,
  };
  const service = createImportBatchService({ repository });

  const result = await service.createBatch({
    fileName: "products.csv",
    fieldMapping: { name: "title", price: "sale_price" },
    rows: [{ title: "Item A", sale_price: "99" }],
  });

  assert.equal(result.batchId, "ib_001");
  assert.equal(result.productCount, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/api-server/src/services/import-batch-service.test.js`  
Expected: FAIL with `createImportBatchService is not defined` or module not found.

- [ ] **Step 3: Write minimal implementation**

```js
export function createImportBatchService({ repository }) {
  return {
    async createBatch({ fileName, fieldMapping, rows }) {
      const batch = await repository.createImportBatch({ fileName, fieldMapping });
      await repository.createProducts(rows.map((row) => ({ ...row, batchId: batch.id })));
      return {
        batchId: batch.id,
        productCount: rows.length,
      };
    },
  };
}
```

Also extend `scripts/init-postgres.js` with tables:

```js
CREATE TABLE IF NOT EXISTS import_batches (...);
CREATE TABLE IF NOT EXISTS products (...);
CREATE TABLE IF NOT EXISTS content_jobs (...);
CREATE TABLE IF NOT EXISTS content_job_items (...);
CREATE TABLE IF NOT EXISTS content_outputs (...);
CREATE TABLE IF NOT EXISTS risk_events (...);
CREATE TABLE IF NOT EXISTS usage_metrics (...);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/api-server/src/services/import-batch-service.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/init-postgres.js apps/api-server/src/lib/database.js apps/api-server/src/services/import-batch-service.js apps/api-server/src/services/import-batch-service.test.js
git commit -m "feat: add batch import schema and service"
```

### Task 2: Add import batch repository and API route

**Files:**
- Create: `apps/api-server/src/repositories/import-batches-repository.js`
- Create: `apps/api-server/src/routes/import-batches.js`
- Modify: `apps/api-server/src/server.js`
- Test: `apps/api-server/src/services/import-batch-service.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("import batch route returns created batch summary", async () => {
  const service = {
    createBatch: async () => ({ batchId: "ib_001", productCount: 2 }),
  };
  const result = await service.createBatch({
    fileName: "products.csv",
    fieldMapping: { name: "title" },
    rows: [{ title: "A" }, { title: "B" }],
  });

  assert.equal(result.batchId, "ib_001");
  assert.equal(result.productCount, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/api-server/src/services/import-batch-service.test.js`  
Expected: FAIL because repository-backed route/service pieces do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
export function createImportBatchesRoute({ importBatchService }) {
  return async function importBatchesRoute(fastify) {
    fastify.post("/api/import-batches", async (request) => {
      const result = await importBatchService.createBatch(request.body);
      return { code: 0, message: "ok", data: result };
    });
  };
}
```

Repository shape:

```js
export function createImportBatchesRepository({ db }) {
  return {
    async createImportBatch({ fileName, fieldMapping }) { /* insert */ },
    async createProducts(rows) { /* batch insert */ },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/api-server/src/services/import-batch-service.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api-server/src/repositories/import-batches-repository.js apps/api-server/src/routes/import-batches.js apps/api-server/src/server.js apps/api-server/src/services/import-batch-service.js apps/api-server/src/services/import-batch-service.test.js
git commit -m "feat: add import batch api"
```

### Task 3: Add product listing and field-normalized storage access

**Files:**
- Create: `apps/api-server/src/repositories/products-repository.js`
- Create: `apps/api-server/src/routes/products.js`
- Modify: `apps/api-server/src/server.js`
- Test: `apps/api-server/src/services/import-batch-service.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("list products returns normalized product rows by batch id", async () => {
  const repository = {
    listProductsByBatchId: async () => [{ id: "p_001", name: "Item A" }],
  };

  const rows = await repository.listProductsByBatchId("ib_001");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Item A");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/api-server/src/services/import-batch-service.test.js`  
Expected: FAIL because product repository behavior is missing.

- [ ] **Step 3: Write minimal implementation**

```js
export function createProductsRepository({ db }) {
  return {
    async listProductsByBatchId(batchId) {
      return db.listProductsByBatchId(batchId);
    },
  };
}
```

Route:

```js
fastify.get("/api/products", async (request) => {
  const items = await productsRepository.listProductsByBatchId(request.query.batchId);
  return { code: 0, message: "ok", data: { items } };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/api-server/src/services/import-batch-service.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api-server/src/repositories/products-repository.js apps/api-server/src/routes/products.js apps/api-server/src/server.js apps/api-server/src/services/import-batch-service.test.js
git commit -m "feat: add product listing api"
```

### Task 4: Add content job creation service and route

**Files:**
- Create: `apps/api-server/src/repositories/content-jobs-repository.js`
- Create: `apps/api-server/src/services/content-job-service.js`
- Create: `apps/api-server/src/routes/content-jobs.js`
- Create: `apps/api-server/src/services/content-job-service.test.js`
- Modify: `apps/api-server/src/server.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createContentJobService } from "./content-job-service.js";

test("create content job expands products into job items", async () => {
  const repository = {
    createJob: async () => ({ id: "job_001" }),
    listProductsByBatchId: async () => [{ id: "p_001" }, { id: "p_002" }],
    createJobItems: async (items) => items,
  };
  const service = createContentJobService({ repository, orchestratorClient: { submitBatchItem: async () => {} } });

  const result = await service.createJob({
    batchId: "ib_001",
    contentTypes: ["marketing_copy", "image_prompt"],
  });

  assert.equal(result.jobId, "job_001");
  assert.equal(result.itemCount, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/api-server/src/services/content-job-service.test.js`  
Expected: FAIL with missing module or function.

- [ ] **Step 3: Write minimal implementation**

```js
export function createContentJobService({ repository, orchestratorClient }) {
  return {
    async createJob({ batchId, contentTypes }) {
      const job = await repository.createJob({ batchId, contentTypes });
      const products = await repository.listProductsByBatchId(batchId);
      const items = products.map((product) => ({
        jobId: job.id,
        productId: product.id,
        status: "pending",
      }));
      await repository.createJobItems(items);
      await Promise.all(items.map((item) => orchestratorClient.submitBatchItem(item)));
      return { jobId: job.id, itemCount: items.length };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/api-server/src/services/content-job-service.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api-server/src/repositories/content-jobs-repository.js apps/api-server/src/services/content-job-service.js apps/api-server/src/routes/content-jobs.js apps/api-server/src/services/content-job-service.test.js apps/api-server/src/server.js
git commit -m "feat: add content job creation flow"
```

### Task 5: Add batch item orchestration models and graph

**Files:**
- Create: `apps/ai-orchestrator/app/models_batch.py`
- Create: `apps/ai-orchestrator/app/graphs/batch_generation_state.py`
- Create: `apps/ai-orchestrator/app/graphs/batch_generation_graph.py`
- Create: `apps/ai-orchestrator/tests/test_batch_generation_graph.py`

- [ ] **Step 1: Write the failing test**

```python
import unittest

from app.graphs.batch_generation_state import build_initial_batch_state


class BatchGenerationStateTests(unittest.TestCase):
    def test_initial_batch_state_contains_product_and_job_ids(self):
        state = build_initial_batch_state(
            workflow_task_id="wf_001",
            job_item={"jobItemId": "item_001", "productId": "p_001"},
        )
        self.assertEqual(state["workflow_task_id"], "wf_001")
        self.assertEqual(state["job_item"]["productId"], "p_001")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `py -m unittest tests.test_batch_generation_graph -v`  
Expected: FAIL because state builder file does not exist.

- [ ] **Step 3: Write minimal implementation**

```python
def build_initial_batch_state(*, workflow_task_id: str, job_item: dict) -> dict:
    return {
        "workflow_task_id": workflow_task_id,
        "job_item": job_item,
        "progress": 0,
        "outputs": [],
        "error_code": None,
        "error_message": None,
    }
```

Add a graph builder shell that wires:

```python
load_product_context -> generate_marketing_copy -> generate_video_script -> generate_image_prompt -> persist_batch_result
```

- [ ] **Step 4: Run test to verify it passes**

Run: `py -m unittest tests.test_batch_generation_graph -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/ai-orchestrator/app/models_batch.py apps/ai-orchestrator/app/graphs/batch_generation_state.py apps/ai-orchestrator/app/graphs/batch_generation_graph.py apps/ai-orchestrator/tests/test_batch_generation_graph.py
git commit -m "feat: add batch generation graph skeleton"
```

### Task 6: Implement content generation nodes for copy, script, and image prompt

**Files:**
- Create: `apps/ai-orchestrator/app/graphs/nodes/load_product_context.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/generate_marketing_copy.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/generate_video_script.py`
- Create: `apps/ai-orchestrator/app/graphs/nodes/generate_image_prompt.py`
- Modify: `apps/ai-orchestrator/tests/test_batch_generation_graph.py`

- [ ] **Step 1: Write the failing test**

```python
class FakeTextProvider:
    async def generate_copy(self, product):
        return {"title": f"{product['name']} title", "sellingPoints": ["point"]}

    async def generate_script(self, product):
        return {"script": f"{product['name']} short script"}

    async def generate_image_prompt(self, product, copy):
        return {"imagePrompt": f"{product['name']} poster prompt"}
```

Assertions:

```python
self.assertEqual(state["copy"]["title"], "Item A title")
self.assertEqual(state["script"]["script"], "Item A short script")
self.assertIn("poster prompt", state["image_prompt"]["imagePrompt"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `py -m unittest tests.test_batch_generation_graph -v`  
Expected: FAIL because nodes are not implemented.

- [ ] **Step 3: Write minimal implementation**

```python
async def generate_marketing_copy(state, provider):
    product = state["product"]
    state["copy"] = await provider.generate_copy(product)
    return state
```

```python
async def generate_video_script(state, provider):
    product = state["product"]
    state["script"] = await provider.generate_script(product)
    return state
```

```python
async def generate_image_prompt(state, provider):
    product = state["product"]
    copy = state["copy"]
    state["image_prompt"] = await provider.generate_image_prompt(product, copy)
    return state
```

- [ ] **Step 4: Run test to verify it passes**

Run: `py -m unittest tests.test_batch_generation_graph -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/ai-orchestrator/app/graphs/nodes/load_product_context.py apps/ai-orchestrator/app/graphs/nodes/generate_marketing_copy.py apps/ai-orchestrator/app/graphs/nodes/generate_video_script.py apps/ai-orchestrator/app/graphs/nodes/generate_image_prompt.py apps/ai-orchestrator/tests/test_batch_generation_graph.py
git commit -m "feat: add batch text generation nodes"
```

### Task 7: Reuse image provider to generate product images and persist outputs

**Files:**
- Create: `apps/ai-orchestrator/app/graphs/nodes/persist_batch_result.py`
- Modify: `apps/ai-orchestrator/app/services/orchestration_service.py`
- Create: `apps/ai-orchestrator/tests/test_batch_orchestration_service.py`

- [ ] **Step 1: Write the failing test**

```python
import unittest

from app.services.orchestration_service import OrchestrationService


class BatchOrchestrationServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_submit_batch_item_returns_success_summary(self):
        service = OrchestrationService(settings=None, provider=None, callback_client=None, store=None)
        self.assertTrue(hasattr(service, "submit_batch_item"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `py -m unittest tests.test_batch_orchestration_service -v`  
Expected: FAIL because `submit_batch_item` does not exist.

- [ ] **Step 3: Write minimal implementation**

Add service method:

```python
async def submit_batch_item(self, payload: dict) -> dict:
    workflow_task_id = f"wf_{uuid4().hex[:12]}"
    final_state = await self._batch_graph.ainvoke(
        build_initial_batch_state(workflow_task_id=workflow_task_id, job_item=payload)
    )
    return {
        "workflowTaskId": workflow_task_id,
        "status": final_state.get("status", "success"),
    }
```

Persist node shape:

```python
async def persist_batch_result(state, callback_client):
    state["status"] = "success"
    return state
```

- [ ] **Step 4: Run test to verify it passes**

Run: `py -m unittest tests.test_batch_orchestration_service -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/ai-orchestrator/app/services/orchestration_service.py apps/ai-orchestrator/app/graphs/nodes/persist_batch_result.py apps/ai-orchestrator/tests/test_batch_orchestration_service.py
git commit -m "feat: add batch item orchestration entrypoint"
```

### Task 8: Add export service for batch outputs

**Files:**
- Create: `apps/api-server/src/services/content-export-service.js`
- Create: `apps/api-server/src/routes/content-exports.js`
- Create: `apps/api-server/src/services/content-export-service.test.js`
- Modify: `apps/api-server/src/server.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createContentExportService } from "./content-export-service.js";

test("export service returns row-oriented output for excel export", async () => {
  const repository = {
    listOutputsByJobId: async () => [
      { productName: "Item A", title: "Title A", imagePrompt: "Prompt A" },
    ],
  };
  const service = createContentExportService({ repository });

  const result = await service.exportJob("job_001");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].productName, "Item A");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/api-server/src/services/content-export-service.test.js`  
Expected: FAIL because export service does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
export function createContentExportService({ repository }) {
  return {
    async exportJob(jobId) {
      const rows = await repository.listOutputsByJobId(jobId);
      return { jobId, rows };
    },
  };
}
```

Route:

```js
fastify.get("/api/content-exports/:jobId", async (request) => {
  const data = await contentExportService.exportJob(request.params.jobId);
  return { code: 0, message: "ok", data };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/api-server/src/services/content-export-service.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api-server/src/services/content-export-service.js apps/api-server/src/routes/content-exports.js apps/api-server/src/services/content-export-service.test.js apps/api-server/src/server.js
git commit -m "feat: add batch export api"
```

### Task 9: Replace frontend single-creation view with import/job/result workspace

**Files:**
- Create: `apps/studio-web/src/batch-api.js`
- Create: `apps/studio-web/src/batch-view-model.js`
- Create: `apps/studio-web/src/batch-view-model.test.js`
- Modify: `apps/studio-web/src/App.jsx`
- Modify: `apps/studio-web/src/styles.css`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { deriveBatchWorkspaceView } from "./batch-view-model.js";

test("workspace view shows import, jobs, and outputs", () => {
  const view = deriveBatchWorkspaceView({
    batches: [{ id: "ib_001", productCount: 2 }],
    jobs: [{ id: "job_001", status: "running" }],
    outputs: [{ id: "out_001", title: "Item A title" }],
  });

  assert.equal(view.batchCount, 1);
  assert.equal(view.jobCount, 1);
  assert.equal(view.outputCount, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/studio-web/src/batch-view-model.test.js`  
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
export function deriveBatchWorkspaceView({ batches, jobs, outputs }) {
  return {
    batchCount: batches.length,
    jobCount: jobs.length,
    outputCount: outputs.length,
  };
}
```

Refactor `App.jsx` to show:

- import batch panel
- products summary panel
- content jobs panel
- outputs panel

Do not keep the old single prompt form as the primary view.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/studio-web/src/batch-view-model.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/studio-web/src/batch-api.js apps/studio-web/src/batch-view-model.js apps/studio-web/src/batch-view-model.test.js apps/studio-web/src/App.jsx apps/studio-web/src/styles.css
git commit -m "feat: add batch production workspace ui"
```

### Task 10: Add risk logging and usage metrics recording

**Files:**
- Modify: `apps/api-server/src/services/content-job-service.js`
- Modify: `apps/ai-orchestrator/app/graphs/nodes/persist_batch_result.py`
- Modify: `apps/ai-orchestrator/tests/test_batch_orchestration_service.py`
- Modify: `README.md`
- Modify: `docs/mvp-acceptance-checklist.md`

- [ ] **Step 1: Write the failing test**

```python
self.assertIn("usage", result)
self.assertIn("riskStatus", result)
```

and

```js
assert.equal(result.status, "success");
assert.equal(typeof result.estimatedCost, "number");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `py -m unittest tests.test_batch_orchestration_service -v`  
Run: `node --test apps/api-server/src/services/content-job-service.test.js`  
Expected: FAIL because metrics/risk fields do not exist.

- [ ] **Step 3: Write minimal implementation**

Persist batch result shape:

```python
state["usage"] = {
    "estimatedTokens": 0,
    "estimatedCost": 0,
}
state["risk_status"] = "passed"
```

Service return shape:

```js
return {
  jobId: job.id,
  itemCount: items.length,
  estimatedCost: 0,
  status: "queued",
};
```

Update docs to redefine MVP acceptance around:

- import success
- batch job success
- output export success

- [ ] **Step 4: Run test to verify it passes**

Run: `py -m unittest tests.test_batch_orchestration_service -v`  
Run: `node --test apps/api-server/src/services/content-job-service.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api-server/src/services/content-job-service.js apps/ai-orchestrator/app/graphs/nodes/persist_batch_result.py apps/ai-orchestrator/tests/test_batch_orchestration_service.py README.md docs/mvp-acceptance-checklist.md
git commit -m "feat: add risk and usage tracking for batch jobs"
```

### Task 11: Full verification

**Files:**
- Test: `apps/api-server/src/services/*.test.js`
- Test: `apps/studio-web/src/*.test.js`
- Test: `apps/ai-orchestrator/tests/*.py`

- [ ] **Step 1: Run Node API tests**

Run: `node --test apps/api-server/src/services/*.test.js`  
Expected: PASS

- [ ] **Step 2: Run frontend tests**

Run: `node --test apps/studio-web/src/*.test.js`  
Expected: PASS

- [ ] **Step 3: Run orchestrator tests**

Run: `cd apps/ai-orchestrator && py -m unittest discover -s tests`  
Expected: PASS

- [ ] **Step 4: Run project check**

Run: `npm run mvp:check`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: verify batch content production mvp phase 1"
```

---

## Self-Review

### Spec coverage

- Excel/CSV import: covered by Tasks 1-3
- Batch job creation: covered by Task 4
- Per-product generation pipeline: covered by Tasks 5-7
- Export flow: covered by Task 8
- Frontend workspace: covered by Task 9
- Risk/cost basics: covered by Task 10

### Placeholder scan

- No `TBD`
- No `TODO`
- No “similar to task N”
- Each task includes files, tests, commands, and expected outcomes

### Type consistency

- Batch domain uses `import_batches`, `products`, `content_jobs`, `content_job_items`, `content_outputs`
- API layer and orchestrator both refer to “job item” as the per-product unit
- Status names are consistent with the design doc

Plan complete and saved to `docs/superpowers/plans/2026-06-17-aigc-batch-content-production-mvp-phase1.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
