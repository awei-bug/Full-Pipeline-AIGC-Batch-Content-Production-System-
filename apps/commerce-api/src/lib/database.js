import pg from "pg";

const { Pool } = pg;

export function hasDatabaseConfig(env = process.env) {
  return Boolean(env.DATABASE_URL || env.PGHOST || env.POSTGRES_HOST);
}

export function buildDatabaseConfig(env = process.env) {
  if (env.DATABASE_URL) {
    return { connectionString: env.DATABASE_URL };
  }

  return {
    host: env.PGHOST || env.POSTGRES_HOST,
    port: Number(env.PGPORT || env.POSTGRES_PORT || 5432),
    user: env.PGUSER || env.POSTGRES_USER,
    password: env.PGPASSWORD || env.POSTGRES_PASSWORD,
    database: env.PGDATABASE || env.POSTGRES_DB,
  };
}

export function createPool(env = process.env) {
  if (!hasDatabaseConfig(env)) {
    return null;
  }
  return new Pool(buildDatabaseConfig(env));
}
