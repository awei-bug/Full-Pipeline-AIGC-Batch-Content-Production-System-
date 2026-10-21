import crypto from "node:crypto";

/**
 * 批次与项目归属相关的约定
 * ----------------------
 * - `projectId` 为空表示"未分配"（历史数据或未指定项目时的兜底）。
 * - 列表查询必须显式传 `projectIds`；传 `null` 表示不过滤（仅限 AUTH_MODE=off
 *   的本地演示，其余场景由路由层决定）。**默认不过滤是实现差异的来源**，所以
 *   这里不给默认值，强迫调用方想清楚。
 */

const UNSCOPED = "__unscoped__";

function mapBatchRow(row) {
  return {
    id: row.id,
    fileName: row.file_name,
    fieldMapping: row.field_mapping,
    productCount: row.product_count,
    projectId: row.project_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoryImportBatchesRepository {
  constructor() {
    this.batches = [];
    this.products = [];
    this.mode = "memory";
  }

  async createImportBatch({ fileName, fieldMapping, projectId = null }) {
    const now = new Date().toISOString();
    const batch = {
      id: `ib_${crypto.randomUUID()}`,
      fileName,
      fieldMapping,
      productCount: 0,
      projectId: projectId || null,
      createdAt: now,
      updatedAt: now,
    };
    this.batches.push(batch);
    return batch;
  }

  async getImportBatch(batchId) {
    return this.batches.find((item) => item.id === String(batchId)) || null;
  }

  async createProducts(rows) {
    const now = new Date().toISOString();
    const created = rows.map((row) => ({
      id: `product_${crypto.randomUUID()}`,
      ...row,
      createdAt: now,
      updatedAt: now,
    }));
    this.products.push(...created);

    for (const row of created) {
      const batch = this.batches.find((item) => item.id === row.batchId);
      if (batch) {
        batch.productCount += 1;
        batch.updatedAt = now;
      }
    }

    return created;
  }

  /**
   * @param {{projectIds?: string[]|null}} options
   *   projectIds 为数组时只返回这些项目的批次；包含 UNSCOPED 时也返回未分配批次；
   *   传 null/undefined 表示不再过滤（仅限 off 模式）。
   */
  async listImportBatches({ projectIds = null } = {}) {
    let rows = [...this.batches];
    if (Array.isArray(projectIds)) {
      const wanted = new Set(projectIds.map(String));
      const includeUnscoped = wanted.has(UNSCOPED);
      rows = rows.filter((item) => {
        if (!item.projectId) return includeUnscoped;
        return wanted.has(item.projectId);
      });
    }
    return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

export class PostgresImportBatchesRepository {
  constructor(pool) {
    this.pool = pool;
    this.mode = "postgres";
  }

  async createImportBatch({ fileName, fieldMapping, projectId = null }) {
    const id = `ib_${crypto.randomUUID()}`;
    const result = await this.pool.query(
      `insert into content_platform.import_batches(
         id,
         file_name,
         field_mapping,
         product_count,
         project_id
       )
       values ($1, $2, $3::jsonb, 0, $4)
       returning
         id,
         file_name,
         field_mapping,
         product_count,
         project_id,
         created_at,
         updated_at`,
      [id, fileName, JSON.stringify(fieldMapping || {}), projectId || null],
    );

    return mapBatchRow(result.rows[0]);
  }

  async getImportBatch(batchId) {
    const result = await this.pool.query(
      `select id, file_name, field_mapping, product_count, project_id, created_at, updated_at
         from content_platform.import_batches
        where id = $1`,
      [String(batchId)],
    );
    return result.rows[0] ? mapBatchRow(result.rows[0]) : null;
  }

  async createProducts(rows) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const created = [];
      for (const row of rows) {
        const id = `product_${crypto.randomUUID()}`;
        const result = await client.query(
          `insert into content_platform.products(
             id,
             import_batch_id,
             source_row_no,
             original_data,
             normalized_data
           )
           values ($1, $2, $3, $4::jsonb, $5::jsonb)
           returning
             id,
             import_batch_id,
             source_row_no,
             original_data,
             normalized_data,
             created_at,
             updated_at`,
          [
            id,
            row.batchId,
            row.sourceRowNo,
            JSON.stringify(row.originalData || {}),
            JSON.stringify(row.normalizedData || {}),
          ],
        );
        created.push(result.rows[0]);
      }

      if (rows.length > 0) {
        await client.query(
          `update content_platform.import_batches
           set product_count = product_count + $2,
               updated_at = now()
           where id = $1`,
          [rows[0].batchId, rows.length],
        );
      }

      await client.query("commit");
      return created;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listImportBatches({ projectIds = null } = {}) {
    const params = [];
    let where = "";
    if (Array.isArray(projectIds)) {
      const wanted = projectIds.map(String);
      const includeUnscoped = wanted.includes("__unscoped__");
      const scoped = wanted.filter((item) => item !== "__unscoped__");
      const clauses = [];
      if (scoped.length > 0) {
        params.push(scoped);
        clauses.push(`project_id = any($${params.length}::text[])`);
      }
      if (includeUnscoped) {
        // 未分配批次只在显式请求时返回。
        clauses.push("project_id is null");
      }
      where = clauses.length > 0 ? `where ${clauses.join(" or ")}` : "where false";
    }
    const result = await this.pool.query(
      `select
         id,
         file_name,
         field_mapping,
         product_count,
         project_id,
         created_at,
         updated_at
       from content_platform.import_batches
       ${where}
       order by created_at desc`,
      params,
    );
    return result.rows.map(mapBatchRow);
  }
}
