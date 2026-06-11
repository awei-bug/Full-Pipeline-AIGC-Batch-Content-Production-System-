function success(request, data, message = "成功") {
  return {
    code: "SUCCESS",
    message,
    requestId: request.id,
    data,
  };
}

function fail(reply, request, statusCode, code, message) {
  reply.code(statusCode).send({
    code,
    message,
    requestId: request.id,
    data: null,
  });
}

export async function appRoutes(fastify) {
  fastify.get("/api/v1/users/me", async (request) => {
    const user = await fastify.store.getDemoUser();
    return success(request, {
      id: user.id,
      username: "演示用户",
      email: null,
      credits: user.credits,
      mode: "演示模式",
    });
  });

  fastify.get("/api/v1/tasks", async (request) => {
    const { status, kind } = request.query ?? {};
    let tasks = await fastify.store.listTasks();
    if (status) {
      tasks = tasks.filter((task) => task.status === status);
    }
    if (kind) {
      tasks = tasks.filter((task) => task.kind === kind);
    }

    return success(request, {
      items: tasks,
      hasMore: false,
      nextCursor: null,
    });
  });

  fastify.get("/api/v1/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params;
    const task = await fastify.store.getTaskById(taskId);
    if (!task) {
      return fail(reply, request, 404, "TASK_NOT_FOUND", "任务不存在");
    }

    return success(request, {
      ...task,
      history: await fastify.store.getTaskHistory(taskId),
    });
  });

  fastify.get("/api/v1/creations/:creationRequestId", async (request, reply) => {
    const { creationRequestId } = request.params;
    const view = await fastify.orchestrator.getCreationView(creationRequestId);
    if (!view) {
      return fail(reply, request, 404, "CREATION_REQUEST_NOT_FOUND", "创作请求不存在");
    }

    return success(request, view);
  });

  fastify.post("/api/v1/creations/images", async (request, reply) => {
    const payload = request.body ?? {};
    if (!payload.prompt?.trim()) {
      return fail(reply, request, 400, "INVALID_PARAM", "请先输入提示词");
    }

    try {
      const result = await fastify.orchestrator.submitCreation({
        kind: "image",
        prompt: payload.prompt.trim(),
        styleCode: payload.styleCode,
        aspectRatio: payload.aspectRatio,
        imageCount: 1,
      });

      return success(
        request,
        {
          creationRequestId: result.creationRequestId,
          taskIds: [result.taskId],
          status: result.status,
        },
        "任务已创建",
      );
    } catch (error) {
      if (error.code === "CREDIT_INSUFFICIENT") {
        return fail(reply, request, 409, "CREDIT_INSUFFICIENT", error.message);
      }
      throw error;
    }
  });

  fastify.post("/api/v1/creations/videos", async (request, reply) => {
    const payload = request.body ?? {};
    if (!payload.prompt?.trim()) {
      return fail(reply, request, 400, "INVALID_PARAM", "请先输入提示词");
    }

    try {
      const result = await fastify.orchestrator.submitCreation({
        kind: "video",
        prompt: payload.prompt.trim(),
        styleCode: payload.styleCode,
        aspectRatio: payload.aspectRatio,
        durationSec: Number(payload.durationSec) || 4,
      });

      return success(
        request,
        {
          creationRequestId: result.creationRequestId,
          taskIds: [result.taskId],
          status: result.status,
        },
        "任务已创建",
      );
    } catch (error) {
      if (error.code === "CREDIT_INSUFFICIENT") {
        return fail(reply, request, 409, "CREDIT_INSUFFICIENT", error.message);
      }
      throw error;
    }
  });

  fastify.get("/api/v1/works", async (request) => {
    return success(request, {
      items: await fastify.store.listWorks(),
      hasMore: false,
      nextCursor: null,
    });
  });

  fastify.get("/api/v1/works/:workId", async (request, reply) => {
    const { workId } = request.params;
    const work = await fastify.store.getWorkById(workId);
    if (!work) {
      return fail(reply, request, 404, "NOT_FOUND", "作品不存在");
    }

    return success(request, work);
  });

  fastify.post("/api/v1/works/:workId/regenerate", async (request, reply) => {
    const { workId } = request.params;
    const payload = request.body ?? {};
    const result = await fastify.orchestrator.regenerateWork(workId, payload.promptOverride?.trim());
    if (!result) {
      return fail(reply, request, 404, "NOT_FOUND", "作品不存在");
    }

    return success(
      request,
      {
        creationRequestId: result.creationRequestId,
        taskIds: [result.taskId],
        status: result.status,
      },
      "任务已创建",
    );
  });
}
