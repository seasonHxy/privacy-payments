import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw Error("TEST_DATABASE_URL required");
const pool = new Pool({ connectionString });
const schema = "pp_browser_" + randomBytes(6).toString("hex");
await pool.query(`CREATE SCHEMA ${schema}`);
const scoped = new URL(connectionString);
scoped.searchParams.set("options", `-c search_path=${schema}`);
try {
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("npm", ["run", "test:e2e"], {
      env: {
        ...process.env,
        STORAGE_DRIVER: "postgres",
        DATABASE_URL: scoped.toString(),
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
}
