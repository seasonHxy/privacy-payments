import { Pool } from "pg";
import { PostgresRepository } from "../../src/postgres.js";
import { Fault } from "../../src/domain.js";
const [key, id, index, when] = process.argv.slice(2);
const schema = process.env.PG_TEST_SCHEMA!;
if (!/^pp_[0-9a-f]+$/.test(schema)) throw Error("Invalid test schema");
const repo = new PostgresRepository(
  new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  }),
  Buffer.from(key!, "hex"),
);
await new Promise((resolve) =>
  setTimeout(resolve, Math.max(0, Number(when) - Date.now())),
);
try {
  await repo.api().start("payer", id!, 1, `pg-process-race-${index}`);
  process.stdout.write("CREATED");
} catch (e) {
  if (e instanceof Fault) process.stdout.write(e.code);
  else throw e;
} finally {
  await repo.close();
}
