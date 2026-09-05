#!/usr/bin/env bash
#
# Apply every migration to a Postgres cluster that has never seen this project.
#
# The test suite cannot do this. Roles are **cluster-global** while migrations
# are per-database, so the first test database to apply a migration containing a
# `CREATE ROLE` leaves that role behind for every database created afterwards —
# including when the migration *failed* partway through. A suite running on a
# warm cluster is therefore structurally incapable of catching an ordering
# defect around roles: it passes, and the deployment to a fresh cluster is the
# first thing that fails.
#
# That is not hypothetical. Migration `0017` created a policy `TO inrsettle_ops`
# twenty lines before creating the role. Every test passed.
#
# `scripts/check-migration-order.mjs` catches the class statically, in CI, in a
# second. This script is the empirical half: it initialises a throwaway cluster,
# applies the migrations in filename order, and reports. Run it before releasing
# a migration that touches roles.
#
#   ./scripts/verify-fresh-cluster.sh
#
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
WORKDIR="$(mktemp -d /tmp/inrsettle-fresh-XXXXXX)"
PORT="${FRESH_PORT:-5439}"
MIGRATIONS="$(cd "$(dirname "$0")/.." && pwd)/packages/db/migrations"

cleanup() {
  "$PGBIN/pg_ctl" -D "$WORKDIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# initdb refuses to run as root, so drop to the postgres user when we are one.
AS_POSTGRES=""
if [ "$(id -u)" = "0" ]; then
  chown postgres:postgres "$WORKDIR"
  AS_POSTGRES="su postgres -c"
fi

run() {
  if [ -n "$AS_POSTGRES" ]; then su postgres -c "$1"; else sh -c "$1"; fi
}

echo "Initialising a throwaway cluster in $WORKDIR …"
run "$PGBIN/initdb -D $WORKDIR/data -A trust -U postgres" >/dev/null
run "$PGBIN/pg_ctl -D $WORKDIR/data -o '-p $PORT -k $WORKDIR' -l $WORKDIR/log start" >/dev/null
sleep 2

export PGHOST="$WORKDIR" PGPORT="$PORT" PGUSER=postgres

residue="$(psql -tAc "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'inrsettle%'")"
if [ "$residue" != "0" ]; then
  echo "FAIL: the throwaway cluster already has inrsettle roles — it is not fresh." >&2
  exit 1
fi
echo "Cluster is genuinely fresh: no inrsettle roles present."

psql -q -c "CREATE DATABASE fresh_check"

# Filename order is application order. `_job.sql` registrations are applied by
# the queue role in deployment and are skipped here; this script is about
# schema and role ordering.
for file in "$MIGRATIONS"/*.sql; do
  name="$(basename "$file")"
  case "$name" in
    *_job.sql|0002_*|0003_*) echo "  skipping $name (queue-role migration)"; continue ;;
  esac
  if ! psql -d fresh_check -q -v ON_ERROR_STOP=1 -f "$file" >/dev/null 2>"$WORKDIR/err"; then
    echo
    echo "FAIL: $name did not apply to a fresh cluster:" >&2
    head -5 "$WORKDIR/err" >&2
    exit 1
  fi
  echo "  applied $name"
done

echo
echo "PASS — every migration applied to a cluster that had never seen this project."
psql -tAc "SELECT 'roles created: ' || string_agg(rolname, ', ' ORDER BY rolname)
             FROM pg_roles WHERE rolname LIKE 'inrsettle%'"
