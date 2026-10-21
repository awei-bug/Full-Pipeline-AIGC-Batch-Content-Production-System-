function normalizeRow(row, fieldMapping) {
  const normalized = {};
  for (const [targetField, sourceField] of Object.entries(fieldMapping || {})) {
    normalized[targetField] = row[sourceField] ?? null;
  }
  return normalized;
}

export function createImportBatchService({ repository }) {
  if (!repository) {
    throw new Error("Missing import batch repository");
  }

  return {
    /**
     * @param {object} input
     * @param {string|null} input.projectId 批次归属项目；为空表示未分配。
     *   权限校验由路由层负责（它知道请求身份），这里只做归属记录。
     */
    async createBatch({ fileName, fieldMapping, rows, projectId = null }) {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("Import rows are required");
      }

      const batch = await repository.createImportBatch({
        fileName,
        fieldMapping,
        projectId,
      });

      const productRows = (rows || []).map((row, index) => ({
        batchId: batch.id,
        sourceRowNo: index + 1,
        originalData: row,
        normalizedData: normalizeRow(row, fieldMapping),
      }));

      await repository.createProducts(productRows);

      return {
        batchId: batch.id,
        productCount: productRows.length,
        projectId: batch.projectId || null,
      };
    },
  };
}
