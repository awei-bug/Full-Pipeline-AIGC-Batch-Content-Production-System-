export function createContentJobService({ repository, orchestratorClient }) {
  if (!repository) {
    throw new Error("Missing content jobs repository");
  }
  if (!orchestratorClient) {
    throw new Error("Missing orchestrator client");
  }

  return {
    async createJob({ batchId, contentTypes }) {
      const normalizedBatchId = String(batchId || "").trim();
      if (!normalizedBatchId) {
        throw new Error("Content job batch id is required");
      }

      const normalizedContentTypes = Array.isArray(contentTypes) ? contentTypes : [];
      const job = await repository.createJob({
        batchId: normalizedBatchId,
        contentTypes: normalizedContentTypes,
      });
      const products = await repository.listProductsByBatchId(normalizedBatchId);
      const items = products.map((product) => ({
        jobId: job.id,
        productId: product.id,
        status: "pending",
      }));

      const createdItems = await repository.createJobItems(items);
      await Promise.all(
        createdItems.map((item, index) =>
          orchestratorClient.submitBatchItem({
            jobItemId: item.id,
            jobId: job.id,
            productId: item.productId,
            contentTypes: normalizedContentTypes,
            productSnapshot: products[index],
          }),
        ),
      );

      return {
        jobId: job.id,
        itemCount: createdItems.length,
      };
    },
  };
}
