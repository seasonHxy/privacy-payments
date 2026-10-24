import { Store, Service, Fault } from "../../src/domain.js";
const [path, key, id, index, at] = process.argv.slice(2);
const store = new Store(path!, Buffer.from(key!, "hex"));
await new Promise((resolve) =>
  setTimeout(resolve, Math.max(0, Number(at) - Date.now())),
);
try {
  new Service(store).start("payer", id!, 1, `process-race-${index}`);
  process.stdout.write("CREATED");
} catch (e) {
  if (e instanceof Fault) process.stdout.write(e.code);
  else throw e;
} finally {
  store.close();
}
