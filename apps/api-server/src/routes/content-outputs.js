import express from "express";

export const contentOutputsRouter = express.Router();

contentOutputsRouter.get("/", async (request, response, next) => {
  try {
    const jobId = String(request.query?.jobId || "").trim();
    if (!jobId) {
      response.status(400).json({
        code: "INVALID_PARAM",
        message: "jobId is required",
        data: null,
      });
      return;
    }

    const items = await request.app.locals.contentJobsRepository.listOutputsByJobId(jobId);
    response.json({
      code: "SUCCESS",
      message: "成功",
      data: { items },
    });
  } catch (error) {
    next(error);
  }
});
