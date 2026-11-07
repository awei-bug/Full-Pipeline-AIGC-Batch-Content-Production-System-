export async function runTrackedHubSync({ jobId, service, statusRepository }) {
  const attempt = await statusRepository.begin(jobId);
  if (!attempt) return { status: "syncing", message: "该任务正在同步" };
  let state;
  try {
    if (!service) {
      state = { status: "not_configured", message: "未配置商品数据中心", received: 0, succeeded: 0, failed: 0 };
    } else {
      const result = await service.ingestJobContent({ jobId });
      const received = Number(result.hub.received || 0);
      const succeeded = Number(result.hub.okCount || 0);
      const failed = Number(result.hub.errorCount || 0) + result.skipped.length;
      const partial = failed > 0 || succeeded !== received || received === 0;
      state = { status: partial ? "partial" : "success", message: partial ? "部分商品未同步，请检查后重试" : "商品知识已同步", received: received + result.skipped.length, succeeded, failed: Math.max(failed, received - succeeded) };
    }
  } catch {
    state = { status: "failed", message: "数据中心同步失败，请检查连接后重试", received: 0, succeeded: 0, failed: 0 };
  }
  await statusRepository.finish(jobId, attempt, state);
  return state;
}
