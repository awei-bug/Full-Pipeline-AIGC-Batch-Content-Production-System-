import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createStore } from "../src/store.js";

const rootDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const dbFile = path.join(rootDir, "data", "platform-db.json");
const assetsDir = path.join(rootDir, "storage", "assets");
const tempDir = path.join(rootDir, "storage", "temp");

async function clearDir(targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await fs.rm(fullPath, { recursive: true, force: true });
    } else {
      await fs.unlink(fullPath);
    }
  }
}

try {
  const store = await createStore({
    dbFile,
    env: process.env,
  });

  await store.clearGeneratedData();
  await clearDir(assetsDir);
  await clearDir(tempDir);

  console.log(`已清空生成数据。当前存储后端：${store.backend}`);
  await store.close();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
