import crypto from "node:crypto";

const DEMO_USER_ID = "user_demo";

const TASK_TYPE_LABELS = {
  text_to_image: "图片作品",
  image_to_image: "图片作品",
  text_to_video: "视频作品",
  image_to_video: "视频作品",
};

function mapTaskRow(row) {
  return {
    id: row.id,
    taskNo: row.task_no,
    creationRequestId: row.creation_request_id,
    projectId: row.project_id,
    userId: row.user_id,
    taskType: row.task_type,
    status: row.status,
    currentStage: row.current_stage,
    providerCode: row.provider_code,
    retryCount: row.retry_count,
    maxRetryCount: row.max_retry_count,
    progress: row.progress,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapWorkRow(row) {
  return {
    id: row.id,
    workNo: row.work_no,
    projectId: row.project_id,
    creationRequestId: row.creation_request_id,
    title: row.title,
    workType: row.work_type,
    status: row.status,
    visibility: row.visibility,
    latestVersionId: row.latest_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkVersionRow(row) {
  return {
    id: row.id,
    workId: row.work_id,
    generationTaskId: row.generation_task_id,
    versionNo: row.version_no,
    versionType: row.version_type,
    promptSnapshot: row.prompt_snapshot,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapAssetRow(row) {
  return {
    id: row.id,
    assetNo: row.asset_no,
    projectId: row.project_id,
    assetType: row.asset_type,
    storageProvider: row.storage_provider,
    objectKey: row.object_key,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    width: row.width,
    height: row.height,
    durationSec: row.duration_sec,
    status: row.status,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildQueuedMetadata(workflowRun, queuedAt) {
  return {
    dispatch: {
      status: "queued",
      queuedAt,
    },
    orchestration: workflowRun,
  };
}

function buildDeferredMetadata(reasonCode, reasonMessage, deferredAt) {
  return {
    dispatch: {
      status: "deferred",
      reasonCode,
      reasonMessage,
      deferredAt,
    },
  };
}

function buildSucceededMetadata({ completedAt, outputs, revisedPrompt }) {
  return {
    dispatch: {
      status: "completed",
      completedAt,
    },
    result: {
      outputCount: outputs.length,
      revisedPrompt: revisedPrompt || null,
    },
  };
}

function buildFailedMetadata({ failedAt, errorCode, errorMessage, externalTaskId = null }) {
  const metadata = {
    dispatch: {
      status: "failed",
      failedAt,
    },
    result: {
      errorCode: errorCode || null,
      errorMessage: errorMessage || null,
    },
  };

  if (externalTaskId) {
    metadata.provider = {
      externalTaskId,
    };
  }

  return metadata;
}

function buildWorkTitle(taskType) {
  return TASK_TYPE_LABELS[taskType] || "创作作品";
}

function normalizeOutput(output) {
  return {
    assetType: String(output.assetType || output.type || "").trim() || "image",
    storageProvider: String(output.storageProvider || "").trim() || "local",
    objectKey: String(output.objectKey || "").trim(),
    fileName: String(output.fileName || "").trim() || null,
    mimeType: String(output.mimeType || "").trim() || null,
    fileSize: output.fileSize ?? null,
    width: output.width ?? null,
    height: output.height ?? null,
    durationSec: output.durationSec ?? null,
    metadata: output.metadata || {},
  };
}

function hydrateWorkEntity(work, latestVersion, assets) {
  return {
    ...work,
    latestVersion,
    assets,
  };
}

export class MemoryWorkflowRepository {
  constructor() {
    this.creationRequests = [];
    this.tasks = [];
    this.works = [];
    this.workVersions = [];
    this.mediaAssets = [];
    this.workAssetRelations = [];
    this.taskStatusHistories = [];
    this.mode = "memory";
  }

  async createCreationRequest({
    projectId,
    prompt,
    requestType = "text_to_image",
    styleCode = null,
    aspectRatio = null,
  }) {
    const creationRequestId = `cr_${crypto.randomUUID()}`;
    const taskId = `task_${crypto.randomUUID()}`;
    const currentTime = new Date().toISOString();

    this.creationRequests.push({
      id: creationRequestId,
      requestNo: `CR_${Date.now()}`,
      projectId,
      userId: DEMO_USER_ID,
      requestType,
      promptText: prompt,
      styleCode,
      aspectRatio,
      status: "submitted",
      metadata: {},
      createdAt: currentTime,
      updatedAt: currentTime,
    });

    const task = {
      id: taskId,
      taskNo: `TASK_${Date.now()}`,
      creationRequestId,
      projectId,
      userId: DEMO_USER_ID,
      taskType: requestType,
      status: "created",
      currentStage: "dispatching",
      providerCode: null,
      retryCount: 0,
      maxRetryCount: 2,
      progress: 0,
      errorCode: null,
      errorMessage: null,
      metadata: {},
      createdAt: currentTime,
      updatedAt: currentTime,
      startedAt: null,
      finishedAt: null,
    };

    this.tasks.push(task);
    this.taskStatusHistories.push({
      id: `th_${crypto.randomUUID()}`,
      taskId,
      fromStatus: null,
      toStatus: "created",
      stageName: "dispatching",
      changeReason: "创作请求已创建",
      createdAt: currentTime,
    });

    return {
      creationRequestId,
      taskId,
      status: "submitted",
    };
  }

  async getTaskById(taskId) {
    return this.tasks.find((task) => task.id === taskId) || null;
  }

  async listTasks({ projectId = null } = {}) {
    const items = projectId ? this.tasks.filter((task) => task.projectId === projectId) : this.tasks;
    return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listWorks({ projectId = null } = {}) {
    const items = projectId ? this.works.filter((work) => work.projectId === projectId) : this.works;

    return [...items]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((work) => {
        const latestVersion = this.workVersions.find((item) => item.id === work.latestVersionId) || null;
        const relations = this.workAssetRelations.filter((item) => item.workVersionId === work.latestVersionId);
        const assets = relations
          .sort((left, right) => left.sortNo - right.sortNo)
          .map((relation) => this.mediaAssets.find((asset) => asset.id === relation.assetId))
          .filter(Boolean);
        return hydrateWorkEntity(work, latestVersion, assets);
      });
  }

  async markTaskQueued({ taskId, providerCode = null, workflowRun }) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) {
      return null;
    }

    const currentTime = new Date().toISOString();
    task.status = "queued";
    task.currentStage = "request_validating";
    task.providerCode = providerCode || task.providerCode;
    task.progress = Math.max(Number(task.progress || 0), 10);
    task.errorCode = null;
    task.errorMessage = null;
    task.startedAt = task.startedAt || currentTime;
    task.updatedAt = currentTime;
    task.metadata = {
      ...(task.metadata || {}),
      ...buildQueuedMetadata(workflowRun, currentTime),
    };
    this.taskStatusHistories.push({
      id: `th_${crypto.randomUUID()}`,
      taskId,
      fromStatus: "created",
      toStatus: "queued",
      stageName: "request_validating",
      changeReason: "编排服务已受理",
      createdAt: currentTime,
    });

    return task;
  }

  async markTaskDispatchDeferred({ taskId, reasonCode, reasonMessage }) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) {
      return null;
    }

    const currentTime = new Date().toISOString();
    task.updatedAt = currentTime;
    task.metadata = {
      ...(task.metadata || {}),
      ...buildDeferredMetadata(reasonCode, reasonMessage, currentTime),
    };

    return task;
  }

  async markTaskSucceeded({
    taskId,
    providerCode = null,
    revisedPrompt = null,
    outputs = [],
  }) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) {
      return null;
    }

    const request = this.creationRequests.find((item) => item.id === task.creationRequestId);
    const currentTime = new Date().toISOString();
    const workId = `work_${crypto.randomUUID()}`;
    const workVersionId = `wv_${crypto.randomUUID()}`;
    const normalizedOutputs = outputs.map(normalizeOutput);

    const assets = normalizedOutputs.map((output, index) => {
      const asset = {
        id: `asset_${crypto.randomUUID()}`,
        assetNo: `A_${Date.now()}_${index + 1}`,
        projectId: task.projectId,
        assetType: output.assetType,
        storageProvider: output.storageProvider,
        objectKey: output.objectKey,
        fileName: output.fileName,
        mimeType: output.mimeType,
        fileSize: output.fileSize,
        width: output.width,
        height: output.height,
        durationSec: output.durationSec,
        status: "ready",
        metadata: output.metadata,
        createdAt: currentTime,
        updatedAt: currentTime,
      };
      this.mediaAssets.push(asset);
      return asset;
    });

    const work = {
      id: workId,
      workNo: `W_${Date.now()}`,
      projectId: task.projectId,
      creationRequestId: task.creationRequestId,
      title: buildWorkTitle(task.taskType),
      workType: task.taskType,
      status: "ready",
      visibility: "private",
      latestVersionId: workVersionId,
      createdAt: currentTime,
      updatedAt: currentTime,
    };
    this.works.push(work);

    const workVersion = {
      id: workVersionId,
      workId,
      generationTaskId: taskId,
      versionNo: 1,
      versionType: "original",
      promptSnapshot: revisedPrompt || request?.promptText || null,
      status: "ready",
      createdAt: currentTime,
    };
    this.workVersions.push(workVersion);

    assets.forEach((asset, index) => {
      this.workAssetRelations.push({
        id: `war_${crypto.randomUUID()}`,
        workVersionId,
        assetId: asset.id,
        relationType: "primary",
        sortNo: index + 1,
        createdAt: currentTime,
      });
    });

    task.status = "success";
    task.currentStage = "completed";
    task.providerCode = providerCode || task.providerCode;
    task.progress = 100;
    task.errorCode = null;
    task.errorMessage = null;
    task.metadata = {
      ...(task.metadata || {}),
      ...buildSucceededMetadata({
        completedAt: currentTime,
        outputs: normalizedOutputs,
        revisedPrompt,
      }),
      work: {
        workId,
        assetIds: assets.map((item) => item.id),
      },
    };
    task.updatedAt = currentTime;
    task.finishedAt = currentTime;

    if (request) {
      request.status = "completed";
      request.updatedAt = currentTime;
      request.metadata = {
        ...(request.metadata || {}),
        work: {
          workId,
        },
      };
    }

    this.taskStatusHistories.push({
      id: `th_${crypto.randomUUID()}`,
      taskId,
      fromStatus: "queued",
      toStatus: "success",
      stageName: "completed",
      changeReason: "编排结果已回写",
      createdAt: currentTime,
    });

    return {
      task,
      work: hydrateWorkEntity(work, workVersion, assets),
    };
  }

  async markTaskFailed({
    taskId,
    providerCode = null,
    errorCode = null,
    externalTaskId = null,
    errorMessage = "任务失败",
  }) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) {
      return null;
    }

    const request = this.creationRequests.find((item) => item.id === task.creationRequestId);
    const currentTime = new Date().toISOString();
    task.status = "failed";
    task.currentStage = "failing";
    task.providerCode = providerCode || task.providerCode;
    task.errorCode = errorCode;
    task.errorMessage = errorMessage;
    task.metadata = {
      ...(task.metadata || {}),
      ...buildFailedMetadata({
        failedAt: currentTime,
        errorCode,
        errorMessage,
        externalTaskId,
      }),
    };
    task.updatedAt = currentTime;
    task.finishedAt = currentTime;

    if (request) {
      request.status = "failed";
      request.updatedAt = currentTime;
    }

    this.taskStatusHistories.push({
      id: `th_${crypto.randomUUID()}`,
      taskId,
      fromStatus: "queued",
      toStatus: "failed",
      stageName: "failing",
      changeReason: errorMessage,
      createdAt: currentTime,
    });

    return { task };
  }
}

export class PostgresWorkflowRepository {
  constructor(pool) {
    this.pool = pool;
    this.mode = "postgres";
  }

  async createCreationRequest({
    projectId,
    prompt,
    requestType = "text_to_image",
    styleCode = null,
    aspectRatio = null,
  }) {
    const creationRequestId = `cr_${crypto.randomUUID()}`;
    const taskId = `task_${crypto.randomUUID()}`;
    const requestNo = `CR_${Date.now()}`;
    const taskNo = `TASK_${Date.now()}`;

    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const projectCheck = await client.query(
        `select id
         from content_platform.projects
         where id = $1`,
        [projectId],
      );

      if (!projectCheck.rowCount) {
        const error = new Error("项目不存在");
        error.code = "PROJECT_NOT_FOUND";
        throw error;
      }

      await client.query(
        `insert into content_platform.creation_requests(
           id,
           request_no,
           project_id,
           user_id,
           request_type,
           prompt_text,
           style_code,
           aspect_ratio,
           status,
           metadata
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted', '{}'::jsonb)`,
        [creationRequestId, requestNo, projectId, DEMO_USER_ID, requestType, prompt, styleCode, aspectRatio],
      );

      await client.query(
        `insert into content_platform.generation_tasks(
           id,
           task_no,
           creation_request_id,
           project_id,
           user_id,
           task_type,
           status,
           current_stage,
           provider_code,
           retry_count,
           max_retry_count,
           progress,
           metadata
         )
         values ($1, $2, $3, $4, $5, $6, 'created', 'dispatching', null, 0, 2, 0, '{}'::jsonb)`,
        [taskId, taskNo, creationRequestId, projectId, DEMO_USER_ID, requestType],
      );

      await client.query(
        `insert into content_platform.task_status_histories(
           id,
           task_id,
           from_status,
           to_status,
           stage_name,
           change_reason,
           operator_type,
           operator_id
         )
         values ($1, $2, null, 'created', 'dispatching', '创作请求已创建', 'system', $3)`,
        [`th_${crypto.randomUUID()}`, taskId, DEMO_USER_ID],
      );

      await client.query("commit");

      return {
        creationRequestId,
        taskId,
        status: "submitted",
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getTaskById(taskId) {
    const result = await this.pool.query(
      `select
         id,
         task_no,
         creation_request_id,
         project_id,
         user_id,
         task_type,
         status,
         current_stage,
         provider_code,
         retry_count,
         max_retry_count,
         progress,
         error_code,
         error_message,
         metadata,
         created_at,
         updated_at,
         started_at,
         finished_at
       from content_platform.generation_tasks
       where id = $1`,
      [taskId],
    );

    if (!result.rowCount) {
      return null;
    }

    return mapTaskRow(result.rows[0]);
  }

  async listTasks({ projectId = null } = {}) {
    const values = [];
    let whereSql = "";

    if (projectId) {
      values.push(projectId);
      whereSql = "where project_id = $1";
    }

    const result = await this.pool.query(
      `select
         id,
         task_no,
         creation_request_id,
         project_id,
         user_id,
         task_type,
         status,
         current_stage,
         provider_code,
         retry_count,
         max_retry_count,
         progress,
         error_code,
         error_message,
         metadata,
         created_at,
         updated_at,
         started_at,
         finished_at
       from content_platform.generation_tasks
       ${whereSql}
       order by created_at desc`,
      values,
    );

    return result.rows.map(mapTaskRow);
  }

  async listWorks({ projectId = null } = {}) {
    const values = [];
    let whereSql = "";

    if (projectId) {
      values.push(projectId);
      whereSql = "where w.project_id = $1";
    }

    const worksResult = await this.pool.query(
      `select
         w.id,
         w.work_no,
         w.project_id,
         w.creation_request_id,
         w.title,
         w.work_type,
         w.status,
         w.visibility,
         w.latest_version_id,
         w.created_at,
         w.updated_at
       from content_platform.works w
       ${whereSql}
       order by w.created_at desc`,
      values,
    );

    if (!worksResult.rowCount) {
      return [];
    }

    const latestVersionIds = worksResult.rows
      .map((row) => row.latest_version_id)
      .filter(Boolean);

    const workIds = worksResult.rows.map((row) => row.id);
    const versionsResult = latestVersionIds.length
      ? await this.pool.query(
          `select
             id,
             work_id,
             generation_task_id,
             version_no,
             version_type,
             prompt_snapshot,
             status,
             created_at
           from content_platform.work_versions
           where id = any($1::text[])`,
          [latestVersionIds],
        )
      : { rows: [] };

    const relationsResult = workIds.length
      ? await this.pool.query(
          `select
             r.work_version_id,
             r.asset_id,
             r.sort_no,
             a.id,
             a.asset_no,
             a.project_id,
             a.asset_type,
             a.storage_provider,
             a.object_key,
             a.file_name,
             a.mime_type,
             a.file_size,
             a.width,
             a.height,
             a.duration_sec,
             a.status,
             a.metadata,
             a.created_at,
             a.updated_at
           from content_platform.work_asset_relations r
           join content_platform.media_assets a on a.id = r.asset_id
           where r.work_version_id = any($1::text[])
           order by r.sort_no asc`,
          [latestVersionIds],
        )
      : { rows: [] };

    const versionsById = new Map(versionsResult.rows.map((row) => [row.id, mapWorkVersionRow(row)]));
    const assetsByVersionId = new Map();
    for (const row of relationsResult.rows) {
      const asset = mapAssetRow(row);
      const list = assetsByVersionId.get(row.work_version_id) || [];
      list.push(asset);
      assetsByVersionId.set(row.work_version_id, list);
    }

    return worksResult.rows.map((row) => {
      const work = mapWorkRow(row);
      const latestVersion = work.latestVersionId ? versionsById.get(work.latestVersionId) || null : null;
      const assets = work.latestVersionId ? assetsByVersionId.get(work.latestVersionId) || [] : [];
      return hydrateWorkEntity(work, latestVersion, assets);
    });
  }

  async markTaskQueued({ taskId, providerCode = null, workflowRun }) {
    const queuedAt = new Date().toISOString();
    const metadataPatch = JSON.stringify(buildQueuedMetadata(workflowRun, queuedAt));

    await this.pool.query(
      `update content_platform.generation_tasks
       set status = 'queued',
           current_stage = 'request_validating',
           provider_code = coalesce($2, provider_code),
           progress = greatest(progress, 10),
           error_code = null,
           error_message = null,
           metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb,
           updated_at = now(),
           started_at = coalesce(started_at, now())
       where id = $1`,
      [taskId, providerCode, metadataPatch],
    );

    await this.pool.query(
      `insert into content_platform.task_status_histories(
         id,
         task_id,
         from_status,
         to_status,
         stage_name,
         change_reason,
         operator_type,
         operator_id
       )
       values ($1, $2, 'created', 'queued', 'request_validating', '编排服务已受理', 'system', $3)`,
      [`th_${crypto.randomUUID()}`, taskId, DEMO_USER_ID],
    );
  }

  async markTaskDispatchDeferred({ taskId, reasonCode, reasonMessage }) {
    const deferredAt = new Date().toISOString();
    const metadataPatch = JSON.stringify(buildDeferredMetadata(reasonCode, reasonMessage, deferredAt));

    await this.pool.query(
      `update content_platform.generation_tasks
       set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb,
           updated_at = now()
       where id = $1`,
      [taskId, metadataPatch],
    );
  }

  async markTaskSucceeded({
    taskId,
    providerCode = null,
    revisedPrompt = null,
    outputs = [],
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const taskResult = await client.query(
        `select
           t.id,
           t.task_no,
           t.creation_request_id,
           t.project_id,
           t.user_id,
           t.task_type,
           t.status,
           t.current_stage,
           t.provider_code,
           t.retry_count,
           t.max_retry_count,
           t.progress,
           t.error_code,
           t.error_message,
           t.metadata,
           t.created_at,
           t.updated_at,
           t.started_at,
           t.finished_at,
           r.prompt_text
         from content_platform.generation_tasks t
         join content_platform.creation_requests r on r.id = t.creation_request_id
         where t.id = $1
         for update`,
        [taskId],
      );

      if (!taskResult.rowCount) {
        throw new Error("任务不存在");
      }

      const task = mapTaskRow(taskResult.rows[0]);
      const promptText = taskResult.rows[0].prompt_text;
      const currentTime = new Date().toISOString();
      const workId = `work_${crypto.randomUUID()}`;
      const workVersionId = `wv_${crypto.randomUUID()}`;
      const workNo = `W_${Date.now()}`;
      const normalizedOutputs = outputs.map(normalizeOutput);

      await client.query(
        `insert into content_platform.works(
           id,
           work_no,
           project_id,
           creation_request_id,
           title,
           work_type,
           status,
           visibility,
           latest_version_id
         )
         values ($1, $2, $3, $4, $5, $6, 'ready', 'private', $7)`,
        [workId, workNo, task.projectId, task.creationRequestId, buildWorkTitle(task.taskType), task.taskType, workVersionId],
      );

      await client.query(
        `insert into content_platform.work_versions(
           id,
           work_id,
           generation_task_id,
           version_no,
           version_type,
           prompt_snapshot,
           status
         )
         values ($1, $2, $3, 1, 'original', $4, 'ready')`,
        [workVersionId, workId, taskId, revisedPrompt || promptText || null],
      );

      const assets = [];
      for (let index = 0; index < normalizedOutputs.length; index += 1) {
        const output = normalizedOutputs[index];
        const assetId = `asset_${crypto.randomUUID()}`;
        const assetNo = `A_${Date.now()}_${index + 1}`;

        await client.query(
          `insert into content_platform.media_assets(
             id,
             asset_no,
             project_id,
             asset_type,
             storage_provider,
             object_key,
             file_name,
             mime_type,
             file_size,
             width,
             height,
             duration_sec,
             status,
             metadata
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ready', $13::jsonb)`,
          [
            assetId,
            assetNo,
            task.projectId,
            output.assetType,
            output.storageProvider,
            output.objectKey,
            output.fileName,
            output.mimeType,
            output.fileSize,
            output.width,
            output.height,
            output.durationSec,
            JSON.stringify(output.metadata || {}),
          ],
        );

        await client.query(
          `insert into content_platform.work_asset_relations(
             id,
             work_version_id,
             asset_id,
             relation_type,
             sort_no
           )
           values ($1, $2, $3, 'primary', $4)`,
          [`war_${crypto.randomUUID()}`, workVersionId, assetId, index + 1],
        );

        assets.push({
          id: assetId,
          assetNo,
          projectId: task.projectId,
          assetType: output.assetType,
          storageProvider: output.storageProvider,
          objectKey: output.objectKey,
          fileName: output.fileName,
          mimeType: output.mimeType,
          fileSize: output.fileSize,
          width: output.width,
          height: output.height,
          durationSec: output.durationSec,
          status: "ready",
          metadata: output.metadata || {},
          createdAt: currentTime,
          updatedAt: currentTime,
        });
      }

      const metadataPatch = JSON.stringify({
        ...buildSucceededMetadata({
          completedAt: currentTime,
          outputs: normalizedOutputs,
          revisedPrompt,
        }),
        work: {
          workId,
          assetIds: assets.map((item) => item.id),
        },
      });

      await client.query(
        `update content_platform.generation_tasks
         set status = 'success',
             current_stage = 'completed',
             provider_code = coalesce($2, provider_code),
             progress = 100,
             error_code = null,
             error_message = null,
             metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb,
             updated_at = now(),
             finished_at = now()
         where id = $1`,
        [taskId, providerCode, metadataPatch],
      );

      await client.query(
        `update content_platform.creation_requests
         set status = 'completed',
             metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb,
             updated_at = now()
         where id = $1`,
        [task.creationRequestId, JSON.stringify({ work: { workId } })],
      );

      await client.query(
        `insert into content_platform.task_status_histories(
           id,
           task_id,
           from_status,
           to_status,
           stage_name,
           change_reason,
           operator_type,
           operator_id
         )
         values ($1, $2, $3, 'success', 'completed', '编排结果已回写', 'system', $4)`,
        [`th_${crypto.randomUUID()}`, taskId, task.status, DEMO_USER_ID],
      );

      await client.query("commit");

      return {
        task: {
          ...task,
          status: "success",
          currentStage: "completed",
          providerCode: providerCode || task.providerCode,
          progress: 100,
          errorCode: null,
          errorMessage: null,
          updatedAt: currentTime,
          finishedAt: currentTime,
          metadata: {
            ...(task.metadata || {}),
            ...JSON.parse(metadataPatch),
          },
        },
        work: {
          id: workId,
          workNo,
          projectId: task.projectId,
          creationRequestId: task.creationRequestId,
          title: buildWorkTitle(task.taskType),
          workType: task.taskType,
          status: "ready",
          visibility: "private",
          latestVersionId: workVersionId,
          createdAt: currentTime,
          updatedAt: currentTime,
          latestVersion: {
            id: workVersionId,
            workId,
            generationTaskId: taskId,
            versionNo: 1,
            versionType: "original",
            promptSnapshot: revisedPrompt || promptText || null,
            status: "ready",
            createdAt: currentTime,
          },
          assets,
        },
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async markTaskFailed({
    taskId,
    providerCode = null,
    errorCode = null,
    externalTaskId = null,
    errorMessage = "任务失败",
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const taskResult = await client.query(
        `select
           id,
           task_no,
           creation_request_id,
           project_id,
           user_id,
           task_type,
           status,
           current_stage,
           provider_code,
           retry_count,
           max_retry_count,
           progress,
           error_code,
           error_message,
           metadata,
           created_at,
           updated_at,
           started_at,
           finished_at
         from content_platform.generation_tasks
         where id = $1
         for update`,
        [taskId],
      );

      if (!taskResult.rowCount) {
        throw new Error("任务不存在");
      }

      const task = mapTaskRow(taskResult.rows[0]);
      const currentTime = new Date().toISOString();
      const metadataPatch = JSON.stringify(
        buildFailedMetadata({
          failedAt: currentTime,
          errorCode,
          errorMessage,
          externalTaskId,
        }),
      );

      await client.query(
        `update content_platform.generation_tasks
         set status = 'failed',
             current_stage = 'failing',
             provider_code = coalesce($2, provider_code),
             error_code = $3,
             error_message = $4,
             metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb,
             updated_at = now(),
             finished_at = now()
         where id = $1`,
        [taskId, providerCode, errorCode, errorMessage, metadataPatch],
      );

      await client.query(
        `update content_platform.creation_requests
         set status = 'failed',
             updated_at = now()
         where id = $1`,
        [task.creationRequestId],
      );

      await client.query(
        `insert into content_platform.task_status_histories(
           id,
           task_id,
           from_status,
           to_status,
           stage_name,
           change_reason,
           operator_type,
           operator_id
         )
         values ($1, $2, $3, 'failed', 'failing', $4, 'system', $5)`,
        [`th_${crypto.randomUUID()}`, taskId, task.status, errorMessage, DEMO_USER_ID],
      );

      await client.query("commit");

      return {
        task: {
          ...task,
          status: "failed",
          currentStage: "failing",
          providerCode: providerCode || task.providerCode,
          errorCode,
          errorMessage,
          updatedAt: currentTime,
          finishedAt: currentTime,
          metadata: {
            ...(task.metadata || {}),
            ...JSON.parse(metadataPatch),
          },
        },
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
