#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Fail rather than silently skip the PostgreSQL suite. Use a disposable local DB.
: "${TEST_DATABASE_URL:?Start local PostgreSQL and export TEST_DATABASE_URL first; see docs/OPERATIONS.md}"
node --input-type=module -e '
const url = new URL(process.env.TEST_DATABASE_URL);
if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error("CI requires a local disposable PostgreSQL database");
if (Number(process.versions.node.split(".")[0]) !== 24) throw Error("Node 24 required");
'
# Tests own their temporary directories/schemas. Never inherit real-mode config.
unset AUTH_MODE PAYMENT_MODE NEAR_AUTH_CONFIG L1_CONFIG APP_ORIGIN STORAGE_DRIVER DATABASE_URL DATA_DIR
npm run lint
npm run typecheck
npm test
npm run build
npm run test:postgres
npm run test:e2e
npm run test:e2e:postgres
