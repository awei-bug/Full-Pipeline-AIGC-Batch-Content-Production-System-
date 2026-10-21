-- 给导入批次加项目归属。
--
-- 背景：`import_batches` 原先没有 `project_id`，`listImportBatches()` 直接返回全表。
-- 结果是任何登录用户都能看到别人导入的商品批次（含成本价、FOB 等敏感字段）。
-- 这不是权限点能解决的问题——权限管的是"能不能写"，这里管的是"能看谁的"。
--
-- 设计取舍：
-- 1. **列可空**。历史批次没有项目归属，填 NULL 而不是伪造一个 project_id。
--    查询侧把 NULL 视为"未分配"，只有显式查询未分配时才能看到。
-- 2. **不设外键级联删除**。删项目不应连带删掉商品批次（可能是从供应商导进来的
--    唯一副本）。项目被删时批次变成"未分配"，由人工处理，比静默丢失安全。
-- 3. 单一归属（一个批次属于一个项目）。若将来需要跨项目复用，再加关联表，
--    从单列迁到多对多是增量改动。
--
-- 幂等：用 add column if not exists，可重复执行。

alter table content_platform.import_batches
  add column if not exists project_id text;

-- 按项目查批次是主要读取路径（列表页 + 权限过滤），加索引。
create index if not exists idx_content_platform_import_batches_project_created
  on content_platform.import_batches(project_id, created_at desc);
