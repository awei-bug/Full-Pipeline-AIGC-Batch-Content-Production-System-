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
    async createBatch({ fileName, fieldMapping, rows }) {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("Import rows are required");
      }

      const batch = await repository.createImportBatch({
        fileName,
        fieldMapping,
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
      };
    },
  };
}
