export function createProductsService({ repository }) {
  if (!repository) {
    throw new Error("Missing products repository");
  }

  return {
    async listByBatchId(batchId) {
      const normalizedBatchId = String(batchId || "").trim();
      if (!normalizedBatchId) {
        throw new Error("Product batch id is required");
      }

      return repository.listProductsByBatchId(normalizedBatchId);
    },
  };
}
