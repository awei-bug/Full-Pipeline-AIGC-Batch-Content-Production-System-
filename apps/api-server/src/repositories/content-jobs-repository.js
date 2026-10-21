import crypto from "node:crypto";

function mapJobRow(row) {
  return {
    id: row.id,
    jobNo: row.job_no,
    batchId: row.import_batch_id,
    status: row.status,
    contentTypes: row.content_types,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapJobItemRow(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    productId: row.product_id,
    status: row.status,
    resultSummary: row.result_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOutputRow(row) {
  return {
    id: row.id,
    jobItemId: row.job_item_id,
    outputType: row.output_type,
    outputData: row.output_data,
    createdAt: row.created_at,
  };
}

export class MemoryContentJobsRepository {
  constructor(productsRepository) {
    this.productsRepository = productsRepository;
    this.jobs = [];
    this.jobItems = [];
    this.outputs = [];
    this.mode = "memory";
  }

  async createJob({ batchId, contentTypes }) {
    const now = new Date().toISOString();
    const job = {
      id: `job_${crypto.randomUUID()}`,
      jobNo: `JOB_${Date.now()}`,
      batchId,
      status: "created",
      contentTypes: contentTypes || [],
      progress: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.push(job);
    return job;
  }

  async listProductsByBatchId(batchId) {
    return this.productsRepository.listProductsByBatchId(batchId);
  }

  async createJobItems(items) {
    const now = new Date().toISOString();
    const created = items.map((item) => ({
      id: `job_item_${crypto.randomUUID()}`,
      ...item,
      resultSummary: {},
      createdAt: now,
      updatedAt: now,
    }));
    this.jobItems.push(...created);
    return created;
  }

  /**
   * @param {{projectIds?: string[]|null}} options
   *   projectIds 为数组时只返回这些项目（或未分配）的批次派生任务；
   *   传 null/undefined 表示不过滤（仅限 AUTH_MODE=off）。
   *
   * 任务**没有自己的 project_id**——它通过 import_batch_id 归属到批次，
   * 批次再归属到项目。所以这里靠批次表关联过滤，不给任务表加冗余列。
   */
  async listJobs({ projectIds = null, batchProjectMap = null } = {}) {
    let rows = [...this.jobs];
    if (Array.isArray(projectIds)) {
      const wanted = new Set(projectIds.map(String));
      const includeUnscoped = wanted.has("__unscoped__");
      rows = rows.filter((job) => {
        const projectId = batchProjectMap?.get?.(job.batchId) ?? null;
        if (!projectId) return includeUnscoped;
        return wanted.has(projectId);
      });
    }
    return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getJobById(jobId) {
    return this.jobs.find((item) => item.id === jobId) || null;
  }

  async getJobItemById(jobItemId) {
    return this.jobItems.find((item) => item.id === jobItemId) || null;
  }

  async updateJobItemResult({
    jobItemId,
    status,
    resultSummary,
  }) {
    const jobItem = this.jobItems.find((item) => item.id === jobItemId);
    if (!jobItem) {
      return null;
    }

    jobItem.status = status;
    jobItem.resultSummary = resultSummary || {};
    jobItem.updatedAt = new Date().toISOString();
    const job = this._recalculateJob(jobItem.jobId);
    return jobItem;
  }

  async createOutputs(jobItemId, outputs) {
    const now = new Date().toISOString();
    const created = (Array.isArray(outputs) ? outputs : []).map((output) => ({
      id: `output_${crypto.randomUUID()}`,
      jobItemId,
      outputType: output.outputType,
      outputData: output.outputData || {},
      createdAt: now,
    }));
    this.outputs.push(...created);
    return created;
  }

  async listOutputsByJobId(jobId) {
    const jobItemIds = this.jobItems
      .filter((item) => item.jobId === jobId)
      .map((item) => item.id);

    return this.outputs.filter((item) => jobItemIds.includes(item.jobItemId));
  }

  async listJobItemsByJobId(jobId) {
    return this.jobItems
      .filter((item) => item.jobId === jobId)
      .map((item) => ({ ...item }));
  }

  async listExportRowsByJobId(jobId) {
    const jobItems = this.jobItems.filter((item) => item.jobId === jobId);
    return jobItems.map((jobItem) => {
      const product = this.productsRepository.importBatchesRepository.products.find(
        (item) => item.id === jobItem.productId,
      );
      const outputs = this.outputs.filter((item) => item.jobItemId === jobItem.id);
      const marketingCopy = outputs.find((item) => item.outputType === "marketing_copy");
      const videoScript = outputs.find((item) => item.outputType === "video_script");
      const imagePrompt = outputs.find((item) => item.outputType === "image_prompt");
      const imageAsset = outputs.find((item) => item.outputType === "image_asset");
      const videoAsset = outputs.find((item) => item.outputType === "video_asset");

      return {
        productId: jobItem.productId,
        productName: product?.normalizedData?.name || "",
        marketingCopyTitle: marketingCopy?.outputData?.title || "",
        videoScript: videoScript?.outputData?.script || "",
        imagePrompt: imagePrompt?.outputData?.prompt || "",
        imageUrl: imageAsset?.outputData?.metadata?.publicUrl || "",
        videoUrl: videoAsset?.outputData?.metadata?.publicUrl || "",
      };
    });
  }

  _recalculateJob(jobId) {
    const job = this.jobs.find((item) => item.id === jobId);
    if (!job) {
      return null;
    }

    const items = this.jobItems.filter((item) => item.jobId === jobId);
    const total = items.length || 1;
    const successCount = items.filter((item) => item.status === "success").length;
    const failedCount = items.filter((item) => item.status === "failed").length;
    const terminalCount = successCount + failedCount;

    job.progress = Math.round((terminalCount / total) * 100);
    if (failedCount > 0) {
      job.status = successCount > 0 ? "partial_success" : "failed";
    } else if (successCount === total && total > 0) {
      job.status = "success";
    } else if (terminalCount > 0) {
      job.status = "running";
    }
    job.updatedAt = new Date().toISOString();
    if (job.status === "success" || job.status === "failed" || job.status === "partial_success") {
      job.finishedAt = job.updatedAt;
    }
    return job;
  }
}

export class PostgresContentJobsRepository {
  constructor(pool, productsRepository) {
    this.pool = pool;
    this.productsRepository = productsRepository;
    this.mode = "postgres";
  }

  async createJob({ batchId, contentTypes }) {
    const id = `job_${crypto.randomUUID()}`;
    const jobNo = `JOB_${Date.now()}`;
    const result = await this.pool.query(
      `insert into content_platform.content_jobs(
         id,
         job_no,
         import_batch_id,
         status,
         content_types,
         progress
       )
       values ($1, $2, $3, 'created', $4::jsonb, 0)
       returning
         id,
         job_no,
         import_batch_id,
         status,
         content_types,
         progress,
         created_at,
         updated_at,
         started_at,
         finished_at`,
      [id, jobNo, batchId, JSON.stringify(contentTypes || [])],
    );
    return mapJobRow(result.rows[0]);
  }

  async listProductsByBatchId(batchId) {
    return this.productsRepository.listProductsByBatchId(batchId);
  }

  async createJobItems(items) {
    const created = [];
    for (const item of items) {
      const id = `job_item_${crypto.randomUUID()}`;
      const result = await this.pool.query(
        `insert into content_platform.content_job_items(
           id,
           job_id,
           product_id,
           status,
           result_summary
         )
         values ($1, $2, $3, $4, '{}'::jsonb)
         returning
           id,
           job_id,
           product_id,
           status,
           result_summary,
           created_at,
           updated_at`,
        [id, item.jobId, item.productId, item.status],
      );
      created.push(mapJobItemRow(result.rows[0]));
    }
    return created;
  }

  /**
   * @param {{projectIds?: string[]|null}} options
   *   任务没有自己的 project_id，靠 import_batches.project_id 关联过滤。
   *   传 null/undefined 表示不过滤（仅限 AUTH_MODE=off）。
   */
  async listJobs({ projectIds = null } = {}) {
    const params = [];
    let where = "";
    if (Array.isArray(projectIds)) {
      const wanted = projectIds.map(String);
      const includeUnscoped = wanted.includes("__unscoped__");
      const scoped = wanted.filter((item) => item !== "__unscoped__");
      const clauses = [];
      if (scoped.length > 0) {
        params.push(scoped);
        clauses.push(`b.project_id = any($${params.length}::text[])`);
      }
      if (includeUnscoped) {
        clauses.push("b.project_id is null");
      }
      where = clauses.length > 0
        ? `where (${clauses.join(" or ")})`
        : "where false";
    }
    const result = await this.pool.query(
      `select
         j.id,
         j.job_no,
         j.import_batch_id,
         j.status,
         j.content_types,
         j.progress,
         j.created_at,
         j.updated_at,
         j.started_at,
         j.finished_at
       from content_platform.content_jobs j
       join content_platform.import_batches b on b.id = j.import_batch_id
       ${where}
       order by j.created_at desc`,
      params,
    );
    return result.rows.map(mapJobRow);
  }

  async getJobById(jobId) {
    const result = await this.pool.query(
      `select
         id,
         job_no,
         import_batch_id,
         status,
         content_types,
         progress,
         created_at,
         updated_at,
         started_at,
         finished_at
       from content_platform.content_jobs
       where id = $1`,
      [jobId],
    );

    if (!result.rowCount) {
      return null;
    }

    return mapJobRow(result.rows[0]);
  }

  async getJobItemById(jobItemId) {
    const result = await this.pool.query(
      `select
         id,
         job_id,
         product_id,
         status,
         result_summary,
         created_at,
         updated_at
       from content_platform.content_job_items
       where id = $1`,
      [jobItemId],
    );

    return result.rowCount ? mapJobItemRow(result.rows[0]) : null;
  }

  async updateJobItemResult({
    jobItemId,
    status,
    resultSummary,
  }) {
    const result = await this.pool.query(
      `update content_platform.content_job_items
       set status = $2,
           result_summary = $3::jsonb,
           updated_at = now()
       where id = $1
       returning
         id,
         job_id,
         product_id,
         status,
         result_summary,
         created_at,
         updated_at`,
      [jobItemId, status, JSON.stringify(resultSummary || {})],
    );

    if (!result.rowCount) {
      return null;
    }

    const jobItem = mapJobItemRow(result.rows[0]);
    await this.recalculateJob(jobItem.jobId);
    return jobItem;
  }

  async createOutputs(jobItemId, outputs) {
    const created = [];
    for (const output of outputs || []) {
      const id = `output_${crypto.randomUUID()}`;
      const result = await this.pool.query(
        `insert into content_platform.content_outputs(
           id,
           job_item_id,
           output_type,
           output_data
         )
         values ($1, $2, $3, $4::jsonb)
         returning
           id,
           job_item_id,
           output_type,
           output_data,
           created_at`,
        [id, jobItemId, output.outputType, JSON.stringify(output.outputData || {})],
      );
      created.push(mapOutputRow(result.rows[0]));
    }
    return created;
  }

  async listOutputsByJobId(jobId) {
    const result = await this.pool.query(
      `select
         o.id,
         o.job_item_id,
         o.output_type,
         o.output_data,
         o.created_at
       from content_platform.content_outputs o
       join content_platform.content_job_items i on i.id = o.job_item_id
       where i.job_id = $1
       order by o.created_at asc`,
      [jobId],
    );

    return result.rows.map(mapOutputRow);
  }

  async listJobItemsByJobId(jobId) {
    const result = await this.pool.query(
      `select
         id,
         job_id,
         product_id,
         status,
         result_summary,
         created_at,
         updated_at
       from content_platform.content_job_items
       where job_id = $1
       order by created_at asc`,
      [jobId],
    );

    return result.rows.map(mapJobItemRow);
  }

  async listExportRowsByJobId(jobId) {
    const result = await this.pool.query(
      `select
         i.product_id as product_id,
         p.normalized_data->>'name' as product_name,
         max(case when o.output_type = 'marketing_copy' then o.output_data->>'title' end) as marketing_copy_title,
         max(case when o.output_type = 'video_script' then o.output_data->>'script' end) as video_script,
         max(case when o.output_type = 'image_prompt' then o.output_data->>'prompt' end) as image_prompt,
         max(case when o.output_type = 'image_asset' then o.output_data->'metadata'->>'publicUrl' end) as image_url,
         max(case when o.output_type = 'video_asset' then o.output_data->'metadata'->>'publicUrl' end) as video_url
       from content_platform.content_job_items i
       join content_platform.products p on p.id = i.product_id
       left join content_platform.content_outputs o on o.job_item_id = i.id
       where i.job_id = $1
       group by i.product_id, p.normalized_data->>'name'
       order by product_name asc`,
      [jobId],
    );

    return result.rows.map((row) => ({
      productId: row.product_id,
      productName: row.product_name || "",
      marketingCopyTitle: row.marketing_copy_title || "",
      videoScript: row.video_script || "",
      imagePrompt: row.image_prompt || "",
      imageUrl: row.image_url || "",
      videoUrl: row.video_url || "",
    }));
  }

  async recalculateJob(jobId) {
    await this.pool.query(
      `with stats as (
         select
           job_id,
           count(*) as total_count,
           count(*) filter (where status = 'success') as success_count,
           count(*) filter (where status = 'failed') as failed_count
         from content_platform.content_job_items
         where job_id = $1
         group by job_id
       )
       update content_platform.content_jobs j
       set progress = case
             when stats.total_count = 0 then 0
             else round(((stats.success_count + stats.failed_count)::numeric / stats.total_count::numeric) * 100)
           end,
           status = case
             when stats.failed_count > 0 and stats.success_count > 0 then 'partial_success'
             when stats.failed_count > 0 then 'failed'
             when stats.success_count = stats.total_count and stats.total_count > 0 then 'success'
             when (stats.success_count + stats.failed_count) > 0 then 'running'
             else j.status
           end,
           updated_at = now(),
           finished_at = case
             when stats.failed_count > 0 or (stats.success_count = stats.total_count and stats.total_count > 0) then now()
             else j.finished_at
           end
       from stats
       where j.id = stats.job_id`,
      [jobId],
    );
  }
}
