import express from "express";

import { writableUserId } from "../lib/identity.js";

export const projectsRouter = express.Router();

/**
 * 项目列表。
 *
 * AUTH_MODE=off 时不传 owner 过滤（沿用旧行为：演示用户看到全部）。
 * 其余模式下按 request.identity 过滤，实现用户隔离；匿名只能拿到空列表——
 * 匿名不写库（见 createIdentityMiddleware），自然也没有项目属于它。
 */
projectsRouter.get("/", async (request, response, next) => {
  try {
    const identity = request.identity;
    const ownerUserId =
      request.identityMode === "off" ? null : identity?.kind === "anonymous" ? "__none__" : identity?.userId;

    const items = await request.app.locals.projectsRepository.list({ ownerUserId });
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

    // 匿名身份不允许创建项目：数据需要一个归属主体，否则后续无法做额度与权限。
    const ownerUserId = writableUserId(request.identity);
    if (!ownerUserId) {
      response.status(401).json({
        code: "UNAUTHORIZED",
        message: "请先登录后再创建项目",
        data: null,
      });
      return;
    }

    const project = await request.app.locals.projectsRepository.create({
      name,
      description,
      ownerUserId: request.identityMode === "off" ? null : ownerUserId,
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
