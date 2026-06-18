import crypto from "node:crypto";

function mapBatchRow(row) {
  return {
    id: row.id,
    fileName: row.file_name,
    fieldMapping: row.field_mapping,
    productCount: row.product_count,
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

  async createImportBatch({ fileName, fieldMapping }) {
    const now = new Date().toISOString();
    const batch = {
      id: `ib_${crypto.randomUUID()}`,
      fileName,
      fieldMapping,
      productCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.batches.push(batch);
    return batch;
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

  async listImportBatches() {
    return [...this.batches].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

export class PostgresImportBatchesRepository {
  constructor(pool) {
    this.pool = pool;
    this.mode = "postgres";
  }

  async createImportBatch({ fileName, fieldMapping }) {
    const id = `ib_${crypto.randomUUID()}`;
    const result = await this.pool.query(
      `insert into content_platform.import_batches(
         id,
         file_name,
         field_mapping,
         product_count
       )
       values ($1, $2, $3::jsonb, 0)
       returning
         id,
         file_name,
         field_mapping,
         product_count,
         created_at,
         updated_at`,
      [id, fileName, JSON.stringify(fieldMapping || {})],
    );

    return mapBatchRow(result.rows[0]);
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

  async listImportBatches() {
    const result = await this.pool.query(
      `select
         id,
         file_name,
         field_mapping,
         product_count,
         created_at,
         updated_at
       from content_platform.import_batches
       order by created_at desc`,
    );
    return result.rows.map(mapBatchRow);
  }
}
