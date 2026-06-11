import crypto from "node:crypto";

const DEMO_OWNER_USER_ID = "user_demo";

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

  async list() {
    return [...this.items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async create({ name, description = null }) {
    const now = new Date().toISOString();
    const project = {
      id: `project_${crypto.randomUUID()}`,
      projectNo: `P_${Date.now()}`,
      name,
      slug: slugify(name) || `project-${Date.now()}`,
      description,
      status: "draft",
      ownerUserId: DEMO_OWNER_USER_ID,
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

  async list() {
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
       order by created_at desc`,
    );
    return result.rows.map(mapProjectRow);
  }

  async create({ name, description = null }) {
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
        [id, projectNo, name, slug, description, DEMO_OWNER_USER_ID],
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
        [`pm_${crypto.randomUUID()}`, id, DEMO_OWNER_USER_ID],
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
