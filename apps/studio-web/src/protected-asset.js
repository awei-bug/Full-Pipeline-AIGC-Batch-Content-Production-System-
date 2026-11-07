// Only local generated files can use the job-scoped authenticated endpoint.
export function jobAssetUrl(apiBaseUrl, jobId, sourceUrl) {
  try {
    if (!jobId || !sourceUrl) return "";
    const base = new URL(apiBaseUrl);
    const source = new URL(sourceUrl, base);
    if (source.origin !== base.origin || source.search || source.hash) return "";
    const match = /^\/storage\/assets\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,199})$/.exec(source.pathname);
    if (!match || match[1].includes("..")) return "";
    return `${base.origin}/api/content-jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(match[1])}`;
  } catch { return ""; }
}

export async function fetchJobAsset(apiBaseUrl, jobId, sourceUrl, token, options = {}) {
  const url = jobAssetUrl(apiBaseUrl, jobId, sourceUrl);
  if (!url || !token) throw new Error("素材暂不可预览");
  const response = await (options.fetchImpl || fetch)(url, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: options.signal,
  });
  if (!response.ok) throw new Error("素材不可用或访问权限已变更");
  return response.blob();
}
