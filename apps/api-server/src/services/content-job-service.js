export function createContentJobService({
  repository,
  orchestratorClient,
  concurrency = Number(process.env.CONTENT_JOB_CONCURRENCY || 3),
}) {
  if (!repository) {
    throw new Error("Missing content jobs repository");
  }
  if (!orchestratorClient) {
    throw new Error("Missing orchestrator client");
  }

  const maxConcurrency = Math.max(1, Number(concurrency) || 3);

  async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runWorker() {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }

    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
  }

  return {
    async createJob({ batchId, contentTypes }) {
      const normalizedBatchId = String(batchId || "").trim();
      if (!normalizedBatchId) {
        throw new Error("Content job batch id is required");
      }

      const normalizedContentTypes = Array.isArray(contentTypes)
        ? contentTypes.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      if (normalizedContentTypes.length === 0) {
        throw new Error("At least one content type is required");
      }

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
      const dispatchErrors = [];

      await mapWithConcurrency(createdItems, maxConcurrency, async (item, index) => {
        try {
          await orchestratorClient.submitBatchItem({
            jobItemId: item.id,
            jobId: job.id,
            productId: item.productId,
            contentTypes: normalizedContentTypes,
            productSnapshot: products[index],
          });
        } catch (error) {
          dispatchErrors.push({
            jobItemId: item.id,
            message: error?.message || "Failed to dispatch batch item",
          });
          if (typeof repository.updateJobItemResult === "function") {
            await repository.updateJobItemResult({
              jobItemId: item.id,
              status: "failed",
              resultSummary: {
                errorCode: "DISPATCH_FAILED",
                errorMessage: error?.message || "Failed to dispatch batch item",
              },
            });
          }
        }
      });

      return {
        jobId: job.id,
        itemCount: createdItems.length,
        dispatchErrorCount: dispatchErrors.length,
        dispatchErrors,
      };
    },
  };
}
