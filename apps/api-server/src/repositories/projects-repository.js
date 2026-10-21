import crypto from "node:crypto";

import { DEMO_USER_ID } from "../lib/identity.js";

/**
 * 项目仓储的 owner 现在由调用方传入（来自 request.identity）。
 *
 * 保留 DEMO_USER_ID 作为**默认值**而不是去掉：既有调用方（脚本、旧测试、
 * 无请求上下文的内部调用）不传 ownerUserId 时行为不变，避免一次性大改。
 * 新代码必须显式传 ownerUserId，否则在 AUTH_MODE=local 下会把用户数据
 * 记到演示用户名下——这是静默错误，比直接报错更难发现。
 */
function resolveOwner(ownerUserId) {
  const value = String(ownerUserId || "").trim();
  return value || DEMO_USER_ID;
}

function slugify(input) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function mapProjectRow(row) {
  return {
    id: row.id,
    projectNo: row.project_no,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    ownerUserId: row.owner_user_id,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoryProjectsRepository {
  constructor() {
    this.items = [];
    this.mode = "memory";
  }

  async list({ ownerUserId = null } = {}) {
    const scope = ownerUserId ? resolveOwner(ownerUserId) : null;
    return [...this.items]
      .filter((item) => (scope ? item.ownerUserId === scope : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async create({ name, description = null, ownerUserId = null }) {
    const now = new Date().toISOString();
    const project = {
      id: `project_${crypto.randomUUID()}`,
      projectNo: `P_${Date.now()}`,
      name,
      slug: slugify(name) || `project-${Date.now()}`,
      description,
      status: "draft",
      ownerUserId: resolveOwner(ownerUserId),
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(project);
    return project;
  }
}

export class PostgresProjectsRepository {
  constructor(pool) {
    this.pool = pool;
    this.mode = "postgres";
  }

  async list({ ownerUserId = null } = {}) {
    // 有 ownerUserId 时按归属过滤，实现用户隔离；不传则返回全部（兼容旧调用）。
    const params = [];
    let where = "";
    if (ownerUserId) {
      params.push(resolveOwner(ownerUserId));
      where = `where owner_user_id = $${params.length}`;
    }
    const result = await this.pool.query(
      `select
         id,
         project_no,
         name,
         slug,
         description,
         status,
         owner_user_id,
         metadata,
         created_at,
         updated_at
       from content_platform.projects
       ${where}
       order by created_at desc`,
      params,
    );
    return result.rows.map(mapProjectRow);
  }

  async create({ name, description = null, ownerUserId = null }) {
    const owner = resolveOwner(ownerUserId);
    const id = `project_${crypto.randomUUID()}`;
    const projectNo = `P_${Date.now()}`;
    const baseSlug = slugify(name) || `project-${Date.now()}`;
    const slug = `${baseSlug}-${id.slice(-8)}`;

    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const projectResult = await client.query(
        `insert into content_platform.projects(
           id,
           project_no,
           name,
           slug,
           description,
           status,
           owner_user_id,
           metadata
         )
         values ($1, $2, $3, $4, $5, 'draft', $6, '{}'::jsonb)
         returning
           id,
           project_no,
           name,
           slug,
           description,
           status,
           owner_user_id,
           metadata,
           created_at,
           updated_at`,
        [id, projectNo, name, slug, description, owner],
      );

      await client.query(
        `insert into content_platform.project_members(
           id,
           project_id,
           user_id,
           role_code,
           status
         )
         values ($1, $2, $3, 'owner', 'active')
         on conflict (project_id, user_id) do nothing`,
        [`pm_${crypto.randomUUID()}`, id, owner],
      );

      await client.query(
        `insert into content_platform.credit_accounts(
           id,
           owner_type,
           owner_id,
           available_credits,
           frozen_credits,
           used_credits
         )
         values ($1, 'project', $2, 0, 0, 0)
         on conflict (owner_type, owner_id) do nothing`,
        [`credit_project_${id.slice(-12)}`, id],
      );

      await client.query("commit");
      return mapProjectRow(projectResult.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
