import express from "express";

export const projectsRouter = express.Router();

projectsRouter.get("/", async (request, response, next) => {
  try {
    const items = await request.app.locals.projectsRepository.list();
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

projectsRouter.post("/", async (request, response, next) => {
  try {
    const name = String(request.body?.name || "").trim();
    const description = String(request.body?.description || "").trim() || null;

    if (!name) {
      response.status(400).json({
        code: "INVALID_PARAM",
        message: "项目名称不能为空",
        data: null,
      });
      return;
    }

    const project = await request.app.locals.projectsRepository.create({
      name,
      description,
    });

    response.status(201).json({
      code: "SUCCESS",
      message: "项目已创建",
      data: project,
    });
  } catch (error) {
    next(error);
  }
});
