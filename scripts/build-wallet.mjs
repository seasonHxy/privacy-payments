import process from "node:process";
import { build } from "esbuild";
await build({
  stdin: {
    contents:
      'export { NearConnector, InjectedWallet } from "@hot-labs/near-connect";',
    resolveDir: process.cwd(),
    sourcefile: "wallet-sdk-entry.js",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "public/generated/wallet-sdk.js",
  minify: true,
  sourcemap: false,
});
