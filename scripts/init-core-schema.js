import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

function hasPostgresConfig(env) {
  return Boolean(env.DATABASE_URL || env.PGHOST || env.POSTGRES_HOST);
}

function buildPostgresConfig(env) {
  if (env.DATABASE_URL) {
    return {
      connectionString: env.DATABASE_URL,
    };
  }

  return {
    host: env.PGHOST || env.POSTGRES_HOST,
    port: Number(env.PGPORT || env.POSTGRES_PORT || 5432),
    user: env.PGUSER || env.POSTGRES_USER,
    password: env.PGPASSWORD || env.POSTGRES_PASSWORD,
    database: env.PGDATABASE || env.POSTGRES_DB,
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlDir = path.resolve(__dirname, "../infra/sql");

const sqlFiles = [
  "001_init_core_schema.sql",
  "002_project_domain.sql",
  "003_workflow_domain.sql",
  "004_credit_domain.sql",
];

try {
  if (!hasPostgresConfig(process.env)) {
    throw new Error("PostgreSQL config not found. Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE first.");
  }

  const pool = new Pool(buildPostgresConfig(process.env));

  try {
    for (const fileName of sqlFiles) {
      const sqlPath = path.join(sqlDir, fileName);
      const sql = await fs.readFile(sqlPath, "utf8");
      await pool.query(sql);
      console.log(`Applied: ${fileName}`);
    }
  } finally {
    await pool.end();
  }

  console.log("Initialized structured core schema: content_platform");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
