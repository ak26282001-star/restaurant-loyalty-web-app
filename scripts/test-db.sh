#!/usr/bin/env bash
# Apply migrations + seed to a database and run the SQL behaviour tests.
# Usage: DATABASE_URL=postgres://... scripts/test-db.sh   (use a throwaway database)
# On plain Postgres (no Supabase), set WITH_AUTH_STUB=1 to create a minimal auth schema first.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL to a throwaway database}"
psql_run() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"; }
if [[ "${WITH_AUTH_STUB:-0}" == "1" ]]; then psql_run -f supabase/tests/auth_stub.sql; fi
for f in supabase/migrations/*.sql; do psql_run -f "$f"; done
psql_run -f supabase/seed.sql
for f in supabase/tests/*.test.sql; do psql_run -f "$f"; done
