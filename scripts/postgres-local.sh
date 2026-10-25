#!/usr/bin/env bash
set -euo pipefail
# Disposable local-only PostgreSQL for fake data. No cloud account, no bind mounts.
# This explicit demo password is not a secret and must never be reused externally.
image='postgres@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6'
case "${1:-start}" in
 start)
  docker run --rm --name privacy-payments-postgres -e POSTGRES_PASSWORD=local-fake-data-only -e POSTGRES_DB=privacy_payments -p 127.0.0.1:55432:5432 -d "$image"
  for attempt in {1..30}; do
   if docker exec privacy-payments-postgres pg_isready -U postgres -d privacy_payments >/dev/null 2>&1; then exit 0; fi
   sleep 1
  done
  echo 'PostgreSQL readiness timeout' >&2; exit 1;;
 stop) docker stop privacy-payments-postgres ;;
 *) echo 'Usage: bash scripts/postgres-local.sh start|stop' >&2; exit 2;;
esac
