import express from "express";

import { createContentExportService } from "../services/content-export-service.js";
import { canReadJob } from "../lib/data-scope.js";

export const contentExportsRouter = express.Router();

contentExportsRouter.get("/:jobId", async (request, response, next) => {
  try {
    if (!await canReadJob(request, request.params.jobId)) {
      return response.status(404).json({ code: "NOT_FOUND", message: "任务不存在或无权访问", data: null });
    }
    const service = createContentExportService({
      repository: request.app.locals.contentJobsRepository,
    });
    const result = await service.exportJob(request.params.jobId);

    response.setHeader("Content-Type", result.contentType);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    );
    response.send(result.buffer);
  } catch (error) {
    next(error);
  }
});
