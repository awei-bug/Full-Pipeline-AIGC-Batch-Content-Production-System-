import express from "express";

export const ipContentRouter = express.Router();

function client(request, response) {
  const upstream = request.app.locals.aiOrchestratorClient;
  if (!upstream?.ipRequest) {
    response.status(503).json({ code: "ORCHESTRATOR_UNAVAILABLE", message: "IP 编排服务未配置", data: null });
    return null;
  }
  return upstream;
}

ipContentRouter.post("/batches", async (request, response, next) => {
  const upstream = client(request, response);
  if (!upstream) return;
  try {
    response.status(202).json({ code: "SUCCESS", data: await upstream.ipRequest("/batches", { method: "POST", body: request.body }) });
  } catch (error) { next(error); }
});

ipContentRouter.get("/batches/:batchId", async (request, response, next) => {
  const upstream = client(request, response);
  if (!upstream) return;
  try {
    response.json({ code: "SUCCESS", data: await upstream.ipRequest(`/batches/${encodeURIComponent(request.params.batchId)}`) });
  } catch (error) { next(error); }
});

ipContentRouter.post("/batches/:batchId/items/:itemId/retry", async (request, response, next) => {
  const upstream = client(request, response);
  if (!upstream) return;
  try {
    const path = `/batches/${encodeURIComponent(request.params.batchId)}/items/${encodeURIComponent(request.params.itemId)}/retry`;
    response.status(202).json({ code: "SUCCESS", data: await upstream.ipRequest(path, { method: "POST" }) });
  } catch (error) { next(error); }
});

ipContentRouter.get("/projects", async (request, response, next) => {
  const upstream = client(request, response);
  if (!upstream) return;
  try { response.json({ code: "SUCCESS", data: await upstream.ipRequest("/projects") }); }
  catch (error) { next(error); }
});

ipContentRouter.get("/projects/:projectId", async (request, response, next) => {
  const upstream = client(request, response);
  if (!upstream) return;
  try { response.json({ code: "SUCCESS", data: await upstream.ipRequest(`/projects/${encodeURIComponent(request.params.projectId)}`) }); }
  catch (error) { next(error); }
});

ipContentRouter.post("/projects", async (request, response, next) => {
  const upstream = client(request, response);
  if (!upstream) return;
  try { response.json({ code: "SUCCESS", data: await upstream.ipRequest("/projects", { method: "POST", body: request.body }) }); }
  catch (error) { next(error); }
});

for (const action of ["review", "revise"]) {
  ipContentRouter.post(`/batches/:batchId/items/:itemId/${action}`, async (request, response, next) => {
    const upstream = client(request, response);
    if (!upstream) return;
    try {
      const path = `/batches/${encodeURIComponent(request.params.batchId)}/items/${encodeURIComponent(request.params.itemId)}/${action}`;
      response.status(action === "revise" ? 202 : 200).json({
        code: "SUCCESS", data: await upstream.ipRequest(path, { method: "POST", body: request.body }),
      });
    } catch (error) { next(error); }
  });
}

ipContentRouter.post("/batches/:batchId/items/:itemId/visuals", async (request, response, next) => {
  const upstream = client(request, response);
  if (!upstream) return;
  try {
    const path = `/batches/${encodeURIComponent(request.params.batchId)}/items/${encodeURIComponent(request.params.itemId)}/visuals`;
    response.status(202).json({
      code: "SUCCESS",
      data: await upstream.ipRequest(path, { method: "POST", body: request.body }),
    });
  } catch (error) { next(error); }
});

ipContentRouter.get("/batches/:batchId/items/:itemId/visuals", async (request, response, next) => {
  const upstream = client(request, response);
  if (!upstream) return;
  try {
    const path = `/batches/${encodeURIComponent(request.params.batchId)}/items/${encodeURIComponent(request.params.itemId)}/visuals`;
    response.json({ code: "SUCCESS", data: await upstream.ipRequest(path) });
  } catch (error) { next(error); }
});
