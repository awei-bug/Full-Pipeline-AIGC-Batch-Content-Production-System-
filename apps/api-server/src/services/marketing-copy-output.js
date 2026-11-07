// Associate a complete generated title/body with the successful product task.
// Keep both fields from the same output; a title is not a description.
export function marketingCopyByProduct(jobItems, outputs) {
  const products = new Map((jobItems || []).filter((item) => item.status === "success").map((item) => [item.id, item.productId]));
  const copies = new Map();
  for (const output of outputs || []) {
    const productId = products.get(output.jobItemId);
    if (!productId || output.outputType !== "marketing_copy") continue;
    const data = output.outputData;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const timestamp = Date.parse(output.createdAt);
    const candidate = { title: typeof data.title === "string" ? data.title.trim() : "", body: typeof data.body === "string" ? data.body.trim() : "", createdAt: Number.isFinite(timestamp) ? timestamp : 0, id: String(output.id || "") };
    const current = copies.get(productId);
    if (!current || candidate.createdAt > current.createdAt || (candidate.createdAt === current.createdAt && candidate.id >= current.id)) copies.set(productId, candidate);
  }
  return copies;
}
