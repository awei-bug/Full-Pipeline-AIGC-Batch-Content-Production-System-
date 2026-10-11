import assert from "node:assert/strict";
import test from "node:test";

import { buildLocalProductCopy, createAiOrchestratorClient } from "./ai-orchestrator-client.js";

test("local product copy fallback builds english listing", () => {
  const copy = buildLocalProductCopy({
    title: "Stainless Bottle",
    description: "Food grade material. Logo customization.",
  });
  assert.match(copy.title, /Stainless Bottle/);
  assert.ok(copy.description.includes("Food grade material"));
  assert.equal(copy.generationMeta.fallbackUsed, true);
});

test("ai client without base url uses local fallback mode", async () => {
  const client = createAiOrchestratorClient({});
  assert.equal(client.mode, "local_fallback");
  const result = await client.generateProductCopy({ title: "Connector" });
  assert.match(result.title, /Connector/);
});
