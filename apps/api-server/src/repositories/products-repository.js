function mapProductMemoryRow(row) {
  return {
    id: row.id,
    batchId: row.batchId,
    sourceRowNo: row.sourceRowNo,
    ...row.normalizedData,
    originalData: row.originalData,
    normalizedData: row.normalizedData,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapProductPostgresRow(row) {
  return {
    id: row.id,
    batchId: row.import_batch_id,
    sourceRowNo: row.source_row_no,
    ...(row.normalized_data || {}),
    originalData: row.original_data,
    normalizedData: row.normalized_data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoryProductsRepository {
  constructor(importBatchesRepository) {
    this.importBatchesRepository = importBatchesRepository;
    this.mode = "memory";
  }

  async listProductsByBatchId(batchId) {
    return (this.importBatchesRepository.products || [])
      .filter((row) => row.batchId === batchId)
      .sort((left, right) => left.sourceRowNo - right.sourceRowNo)
      .map(mapProductMemoryRow);
  }
}

export class PostgresProductsRepository {
  constructor(pool) {
    this.pool = pool;
    this.mode = "postgres";
  }

  async listProductsByBatchId(batchId) {
    const result = await this.pool.query(
      `select
         id,
         import_batch_id,
         source_row_no,
         original_data,
         normalized_data,
         created_at,
         updated_at
       from content_platform.products
       where import_batch_id = $1
       order by source_row_no asc`,
      [batchId],
    );
    return result.rows.map(mapProductPostgresRow);
  }
}
