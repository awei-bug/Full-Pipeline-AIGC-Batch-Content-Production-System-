import express from "express";

export const worksRouter = express.Router();

worksRouter.get("/", async (request, response, next) => {
  try {
    const projectId = String(request.query?.projectId || "").trim() || null;
    const items = await request.app.locals.workflowRepository.listWorks({ projectId });
    response.json({
      code: "SUCCESS",
      message: "成功",
      data: {
        items,
        hasMore: false,
      },
    });
  } catch (error) {
    next(error);
  }
});
