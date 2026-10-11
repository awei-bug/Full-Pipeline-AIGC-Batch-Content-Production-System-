function normalizeOutputs(outputs) {
  return (Array.isArray(outputs) ? outputs : []).map((output) => ({
    outputType: String(output?.outputType || "").trim(),
    outputData: output?.outputData || {},
  }));
}

export async function applyBatchItemEvent({
  contentJobsRepository,
  event,
}) {
  if (!contentJobsRepository) {
    throw new Error("Missing content jobs repository");
  }

  const jobItemId = String(event?.jobItemId || "").trim();
  const normalizedStatus = String(event?.status || "").trim().toLowerCase();

  if (!jobItemId || !normalizedStatus) {
    const error = new Error("Batch item event requires job item id and status");
    error.code = "INVALID_PARAM";
    throw error;
  }

  const existingJobItem = await contentJobsRepository.getJobItemById?.(jobItemId);
  const targetStatus = normalizedStatus === "succeeded" ? "success" : normalizedStatus;
  if (existingJobItem?.status === targetStatus) {
    const job = await contentJobsRepository.getJobById?.(existingJobItem.jobId);
    return {
      jobItem: existingJobItem,
      job,
      outputs: [],
      idempotent: true,
    };
  }

  if (normalizedStatus === "succeeded") {
    const resultSummary = {
      usage: event?.usage || {},
      riskStatus: String(event?.riskStatus || "").trim() || "passed",
      warnings: Array.isArray(event?.warnings) ? event.warnings : [],
    };
    const jobItem = await contentJobsRepository.updateJobItemResult({
      jobItemId,
      status: "success",
      resultSummary,
    });
    const outputs = await contentJobsRepository.createOutputs(jobItemId, normalizeOutputs(event?.outputs));
    const job = jobItem ? await contentJobsRepository.getJobById?.(jobItem.jobId) : null;
    return { jobItem, job, outputs, idempotent: false };
  }

  if (normalizedStatus === "failed") {
    const jobItem = await contentJobsRepository.updateJobItemResult({
      jobItemId,
      status: "failed",
      resultSummary: {
        errorCode: String(event?.errorCode || "").trim() || null,
        errorMessage: String(event?.errorMessage || "batch item failed").trim(),
      },
    });
    const job = jobItem ? await contentJobsRepository.getJobById?.(jobItem.jobId) : null;
    return { jobItem, job, outputs: [], idempotent: false };
  }

  const error = new Error("Unsupported batch item event status");
  error.code = "INVALID_STATUS";
  throw error;
}
