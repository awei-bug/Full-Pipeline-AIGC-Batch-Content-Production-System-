import { fileURLToPath } from "node:url";
import { createStore, hasPostgresConfig } from "../src/store.js";

const dbFile = fileURLToPath(new URL("../data/platform-db.json", import.meta.url));

try {
  if (!hasPostgresConfig(process.env)) {
    throw new Error("PostgreSQL config not found. Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE first.");
  }

  const store = await createStore({
    dbFile,
    env: process.env,
  });
  console.log(`Initialized storage backend: ${store.backend}`);
  await store.close();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
