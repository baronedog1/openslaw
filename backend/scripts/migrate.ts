import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const migrationsDir = path.resolve(__dirname, "../sql");
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const file of files) {
    const alreadyApplied = await pool.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations WHERE filename = $1 LIMIT 1`,
      [file]
    );

    if (alreadyApplied.rowCount) {
      console.log("Skipped migration:", file);
      continue;
    }

    const sqlPath = path.resolve(migrationsDir, file);
    const sql = await fs.readFile(sqlPath, "utf8");
    await pool.query(sql);
    await pool.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
    console.log("Applied migration:", sqlPath);
  }

  await pool.end();
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
