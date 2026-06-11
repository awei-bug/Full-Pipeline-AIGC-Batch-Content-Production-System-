import { promises as fs } from "node:fs";
import { Pool } from "pg";

const DEMO_USER_ID = "user_demo";

function now() {
  return new Date().toISOString();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialDb() {
  return {
    meta: {
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    },
    users: [
      {
        id: DEMO_USER_ID,
        username: "demo_user",
        email: "demo@example.com",
        credits: {
          available: 1000,
          frozen: 0,
          used: 0,
        },
        createdAt: now(),
        updatedAt: now(),
      },
    ],
    creationRequests: [],
    tasks: [],
    taskHistories: [],
    works: [],
    assets: [],
  };
}

function hasPostgresConfig(env) {
  return Boolean(env.DATABASE_URL || env.PGHOST || env.POSTGRES_HOST);
}

class JsonFileStore {
  constructor(dbFile) {
    this.dbFile = dbFile;
    this.db = null;
    this.backend = "json";
  }

  async init() {
    try {
      const content = await fs.readFile(this.dbFile, "utf8");
      this.db = JSON.parse(content);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      this.db = initialDb();
      await this.#persist();
    }
  }

  getDemoUser() {
    return deepClone(this.db.users[0]);
  }

  listWorks() {
    return [...this.db.works].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(deepClone);
  }

  getWorkById(workId) {
    const work = this.db.works.find((item) => item.id === workId);
    return work ? deepClone(work) : null;
  }

  listTasks() {
    return [...this.db.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(deepClone);
  }

  getTaskById(taskId) {
    const task = this.db.tasks.find((item) => item.id === taskId);
    return task ? deepClone(task) : null;
  }

  getCreationRequestById(requestId) {
    const request = this.db.creationRequests.find((item) => item.id === requestId);
    return request ? deepClone(request) : null;
  }

  getAssetById(assetId) {
    const asset = this.db.assets.find((item) => item.id === assetId);
    return asset ? deepClone(asset) : null;
  }

  async createCreationBundle(bundle) {
    this.db.creationRequests.push(deepClone(bundle.creationRequest));
    this.db.tasks.push(deepClone(bundle.task));
    this.db.taskHistories.push(deepClone(bundle.history));
    await this.#persist();
  }

  async updateTask(taskId, updater) {
    const task = this.db.tasks.find((item) => item.id === taskId);
    if (!task) {
      return null;
    }

    updater(task);
    task.updatedAt = now();
    this.db.meta.updatedAt = now();
    await this.#persist();
    return deepClone(task);
  }

  async appendTaskHistory(history) {
    this.db.taskHistories.push(deepClone(history));
    this.db.meta.updatedAt = now();
    await this.#persist();
  }

  async updateCreationRequest(requestId, updater) {
    const request = this.db.creationRequests.find((item) => item.id === requestId);
    if (!request) {
      return null;
    }

    updater(request);
    request.updatedAt = now();
    this.db.meta.updatedAt = now();
    await this.#persist();
    return deepClone(request);
  }

  async createAsset(asset) {
    this.db.assets.push(deepClone(asset));
    this.db.meta.updatedAt = now();
    await this.#persist();
    return deepClone(asset);
  }

  async createWork(work) {
    this.db.works.push(deepClone(work));
    this.db.meta.updatedAt = now();
    await this.#persist();
    return deepClone(work);
  }

  async updateCredits(updater) {
    const user = this.db.users[0];
    updater(user.credits);
    user.updatedAt = now();
    this.db.meta.updatedAt = now();
    await this.#persist();
  }

  getTaskHistory(taskId) {
    return this.db.taskHistories
      .filter((item) => item.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(deepClone);
  }

  async clearGeneratedData() {
    const user = this.db.users[0];
    user.credits.available += user.credits.frozen;
    user.credits.frozen = 0;
    user.updatedAt = now();
    this.db.creationRequests = [];
    this.db.tasks = [];
    this.db.taskHistories = [];
    this.db.works = [];
    this.db.assets = [];
    this.db.meta.updatedAt = now();
    await this.#persist();
  }

  async close() {}

  async #persist() {
    this.db.meta.updatedAt = now();
    await fs.writeFile(this.dbFile, JSON.stringify(this.db, null, 2), "utf8");
  }
}

class PostgresStore {
  constructor(connectionConfig) {
    this.pool = new Pool(connectionConfig);
    this.backend = "postgres";
  }

  async init() {
    await this.pool.query(`
      create table if not exists users (
        id text primary key,
        data jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists creation_requests (
        id text primary key,
        data jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists tasks (
        id text primary key,
        data jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists task_histories (
        id text primary key,
        task_id text not null,
        data jsonb not null,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_task_histories_task_id on task_histories(task_id, created_at asc);
      create table if not exists works (
        id text primary key,
        data jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists assets (
        id text primary key,
        data jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);

    const user = await this.getDemoUser();
    if (!user) {
      const seed = initialDb().users[0];
      await this.#upsertEntity("users", seed.id, seed);
    }
  }

  async getDemoUser() {
    return this.#getEntity("users", DEMO_USER_ID);
  }

  async listWorks() {
    return this.#listEntities("works");
  }

  async getWorkById(workId) {
    return this.#getEntity("works", workId);
  }

  async listTasks() {
    return this.#listEntities("tasks");
  }

  async getTaskById(taskId) {
    return this.#getEntity("tasks", taskId);
  }

  async getCreationRequestById(requestId) {
    return this.#getEntity("creation_requests", requestId);
  }

  async getAssetById(assetId) {
    return this.#getEntity("assets", assetId);
  }

  async createCreationBundle(bundle) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.#upsertEntityWithClient(client, "creation_requests", bundle.creationRequest.id, bundle.creationRequest);
      await this.#upsertEntityWithClient(client, "tasks", bundle.task.id, bundle.task);
      await client.query(
        `insert into task_histories(id, task_id, data, created_at)
         values ($1, $2, $3::jsonb, $4::timestamptz)
         on conflict (id) do update set data = excluded.data, task_id = excluded.task_id, created_at = excluded.created_at`,
        [bundle.history.id, bundle.history.taskId, JSON.stringify(bundle.history), bundle.history.createdAt],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateTask(taskId, updater) {
    const task = await this.getTaskById(taskId);
    if (!task) {
      return null;
    }

    updater(task);
    task.updatedAt = now();
    await this.#upsertEntity("tasks", taskId, task);
    return task;
  }

  async appendTaskHistory(history) {
    await this.pool.query(
      `insert into task_histories(id, task_id, data, created_at)
       values ($1, $2, $3::jsonb, $4::timestamptz)
       on conflict (id) do update set data = excluded.data, task_id = excluded.task_id, created_at = excluded.created_at`,
      [history.id, history.taskId, JSON.stringify(history), history.createdAt],
    );
  }

  async updateCreationRequest(requestId, updater) {
    const request = await this.getCreationRequestById(requestId);
    if (!request) {
      return null;
    }

    updater(request);
    request.updatedAt = now();
    await this.#upsertEntity("creation_requests", requestId, request);
    return request;
  }

  async createAsset(asset) {
    await this.#upsertEntity("assets", asset.id, asset);
    return deepClone(asset);
  }

  async createWork(work) {
    await this.#upsertEntity("works", work.id, work);
    return deepClone(work);
  }

  async updateCredits(updater) {
    const user = await this.getDemoUser();
    updater(user.credits);
    user.updatedAt = now();
    await this.#upsertEntity("users", user.id, user);
  }

  async getTaskHistory(taskId) {
    const result = await this.pool.query(
      `select data
       from task_histories
       where task_id = $1
       order by created_at asc`,
      [taskId],
    );
    return result.rows.map((row) => row.data);
  }

  async clearGeneratedData() {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const user = await this.getDemoUser();
      if (user) {
        user.credits.available += user.credits.frozen;
        user.credits.frozen = 0;
        user.updatedAt = now();
        await this.#upsertEntityWithClient(client, "users", user.id, user);
      }
      await client.query(`
        truncate table
          task_histories,
          creation_requests,
          tasks,
          works,
          assets
        restart identity;
      `);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  async #getEntity(tableName, id) {
    const result = await this.pool.query(
      `select data
       from ${tableName}
       where id = $1`,
      [id],
    );
    return result.rows[0]?.data ?? null;
  }

  async #listEntities(tableName) {
    const result = await this.pool.query(
      `select data
       from ${tableName}
       order by created_at desc`,
    );
    return result.rows.map((row) => row.data);
  }

  async #upsertEntity(tableName, id, data) {
    await this.pool.query(
      `insert into ${tableName}(id, data, created_at, updated_at)
       values ($1, $2::jsonb, ($2::jsonb->>'createdAt')::timestamptz, ($2::jsonb->>'updatedAt')::timestamptz)
       on conflict (id) do update
       set data = excluded.data,
           updated_at = excluded.updated_at`,
      [id, JSON.stringify(data)],
    );
  }

  async #upsertEntityWithClient(client, tableName, id, data) {
    await client.query(
      `insert into ${tableName}(id, data, created_at, updated_at)
       values ($1, $2::jsonb, ($2::jsonb->>'createdAt')::timestamptz, ($2::jsonb->>'updatedAt')::timestamptz)
       on conflict (id) do update
       set data = excluded.data,
           updated_at = excluded.updated_at`,
      [id, JSON.stringify(data)],
    );
  }
}

export async function createStore({ dbFile, env = process.env }) {
  if (!hasPostgresConfig(env)) {
    const store = new JsonFileStore(dbFile);
    await store.init();
    return store;
  }

  const connectionString = env.DATABASE_URL;
  const postgresConfig = connectionString
    ? { connectionString }
    : {
        host: env.PGHOST || env.POSTGRES_HOST,
        port: Number(env.PGPORT || env.POSTGRES_PORT || 5432),
        user: env.PGUSER || env.POSTGRES_USER,
        password: env.PGPASSWORD || env.POSTGRES_PASSWORD,
        database: env.PGDATABASE || env.POSTGRES_DB,
      };

  const store = new PostgresStore(postgresConfig);
  await store.init();
  return store;
}

export { DEMO_USER_ID };
export { hasPostgresConfig };
