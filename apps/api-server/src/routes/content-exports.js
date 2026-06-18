import express from "express";

import { createContentExportService } from "../services/content-export-service.js";

export const contentExportsRouter = express.Router();

contentExportsRouter.get("/:jobId", async (request, response, next) => {
  try {
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
