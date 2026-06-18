import assert from "node:assert/strict";
import test from "node:test";

import { createContentExportService } from "./content-export-service.js";

test("export service returns xlsx workbook payload for content outputs", async () => {
  const repository = {
    async listExportRowsByJobId(jobId) {
      assert.equal(jobId, "job_001");
      return [
        {
          productId: "product_001",
          productName: "防晒喷雾",
          marketingCopyTitle: "夏季清爽防晒喷雾",
          videoScript: "开场展示防晒喷雾，突出清爽不油腻。",
          imagePrompt: "高级感防晒喷雾海报，都市通勤场景",
          imageUrl: "/storage/assets/wf_001.png",
        },
      ];
    },
  };
  const service = createContentExportService({ repository });

  const result = await service.exportJob("job_001");

  assert.equal(result.jobId, "job_001");
  assert.equal(result.fileName, "job_001-批量内容结果.xlsx");
  assert.equal(
    result.contentType,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.ok(result.buffer.length > 0);
});
