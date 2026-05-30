#!/usr/bin/env bash
#
# apply-migrations.sh — safe runner for lib/db/migrations/*.sql
#
# Targets production Postgres (Supabase or any Postgres reachable via psql).
# Each migration runs in its own transaction (-1) with ON_ERROR_STOP so a
# partial failure rolls back cleanly. Stops on first failure.
#
# Usage:
#   ./scripts/apply-migrations.sh              # interactive, with backup
#   ./scripts/apply-migrations.sh --yes        # skip confirmation prompt
#   ./scripts/apply-migrations.sh --no-backup  # skip pg_dump backup
#
# Requires: DATABASE_URL env var, psql in PATH. pg_dump is optional.

set -euo pipefail

# --- locate repo root (script may be invoked from anywhere) -----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/lib/db/migrations"

# --- color helpers (only when stdout is a TTY) ------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BOLD=$'\033[1m'
  CHECK="${C_GREEN}\xe2\x9c\x93${C_RESET}"
  CROSS="${C_RED}\xe2\x9c\x97${C_RESET}"
else
  C_RESET=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_BOLD=""
  CHECK="PASS"
  CROSS="FAIL"
fi

info()  { printf '%s\n' "$*"; }
warn()  { printf '%bwarn:%b %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()   { printf '%berror:%b %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
pass()  { printf '  %b %s\n' "$CHECK" "$1"; }
fail()  { printf '  %b %s\n' "$CROSS" "$1"; }

# --- parse flags ------------------------------------------------------------
SKIP_CONFIRM=0
DO_BACKUP=1
for arg in "$@"; do
  case "$arg" in
    --yes|-y)       SKIP_CONFIRM=1 ;;
    --no-backup)    DO_BACKUP=0 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      err "unknown argument: $arg"
      exit 2
      ;;
  esac
done

# --- require DATABASE_URL ---------------------------------------------------
if [ -z "${DATABASE_URL:-}" ]; then
  err "DATABASE_URL is not set."
  err "Export your Postgres connection string, e.g.:"
  err "  export DATABASE_URL='postgresql://user:pass@host:5432/dbname'"
  err "For Supabase, use the *direct* connection on port 5432, not the pooler (6543)."
  exit 1
fi

command -v psql >/dev/null 2>&1 || { err "psql not found in PATH"; exit 1; }

# --- redact password, extract host + db for display -------------------------
# Strip credentials between scheme and host: scheme://user:pass@host -> scheme://host
redact_url() {
  local url="$1"
  printf '%s' "$url" | sed -E 's#(://)[^@/]+@#\1#'
}

# Pull host and dbname out via psql itself — safest parser available.
# Falls back to redacted URL if psql can't reach the server.
CONN_HOST="$(psql "$DATABASE_URL" -Atc "SELECT inet_server_addr()::text || ' (' || current_setting('server_version') || ')'" 2>/dev/null || true)"
CONN_DB="$(psql "$DATABASE_URL" -Atc "SELECT current_database()" 2>/dev/null || true)"
REDACTED_URL="$(redact_url "$DATABASE_URL")"

info "${C_BOLD}Migration target${C_RESET}"
info "  url:  $REDACTED_URL"
[ -n "$CONN_DB"   ] && info "  db:   $CONN_DB"
[ -n "$CONN_HOST" ] && info "  host: $CONN_HOST"

# --- confirmation -----------------------------------------------------------
if [ "$SKIP_CONFIRM" -ne 1 ]; then
  printf 'Apply migrations to this database? [y/N] '
  read -r reply || reply=""
  case "$reply" in
    y|Y|yes|YES) ;;
    *) info "Aborted."; exit 0 ;;
  esac
fi

# --- backup -----------------------------------------------------------------
if [ "$DO_BACKUP" -eq 1 ]; then
  if command -v pg_dump >/dev/null 2>&1; then
    TS="$(date +%Y%m%d_%H%M%S)"
    BACKUP_FILE="$REPO_ROOT/backup_${TS}.sql"
    info "Taking backup -> $BACKUP_FILE"
    if pg_dump "$DATABASE_URL" --no-owner --no-privileges > "$BACKUP_FILE"; then
      info "Backup written ($(wc -c < "$BACKUP_FILE") bytes)"
    else
      err "pg_dump failed — aborting before any migration runs."
      err "Re-run with --no-backup to skip (NOT recommended for prod)."
      exit 1
    fi
  else
    warn "pg_dump not found; continuing without backup."
    warn "Re-run with --no-backup to silence this warning if intentional."
  fi
else
  warn "Skipping backup (--no-backup)."
fi

# --- collect migrations in numeric order ------------------------------------
if [ ! -d "$MIGRATIONS_DIR" ]; then
  err "migrations dir not found: $MIGRATIONS_DIR"
  exit 1
fi

# Use a sorted array; LC_ALL=C makes numeric-prefixed files sort lexicographically
# in a stable cross-platform way (BSD/GNU sort agree).
migrations=()
while IFS= read -r f; do
  migrations+=("$f")
done < <(LC_ALL=C find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | LC_ALL=C sort)

if [ "${#migrations[@]}" -eq 0 ]; then
  warn "no *.sql files found in $MIGRATIONS_DIR"
  exit 0
fi

# --- apply ------------------------------------------------------------------
applied=0
for file in "${migrations[@]}"; do
  name="$(basename "$file")"
  printf '\n=== applying %s ===\n' "$name"
  if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f "$file"; then
    applied=$((applied + 1))
  else
    err "migration $name failed; stopping."
    err "The failed migration was rolled back (single-transaction mode)."
    if [ "$DO_BACKUP" -eq 1 ] && [ -n "${BACKUP_FILE:-}" ]; then
      err "Restore with:  psql \"\$DATABASE_URL\" -f $BACKUP_FILE"
    fi
    exit 1
  fi
done

# --- verify -----------------------------------------------------------------
printf '\n%bVerifications%b\n' "$C_BOLD" "$C_RESET"

passed=0
failed=0

# Helper: run a SQL boolean check; arg1 = label, arg2 = SQL returning 't' or 'f'
check_sql() {
  local label="$1" sql="$2" result
  result="$(psql "$DATABASE_URL" -Atc "$sql" 2>/dev/null || echo "ERR")"
  if [ "$result" = "t" ]; then
    pass "$label"
    passed=$((passed + 1))
  else
    fail "$label (got: $result)"
    failed=$((failed + 1))
  fi
}

check_sql "risk_config table exists with at least one row" \
  "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='risk_config') AND (SELECT COUNT(*) FROM risk_config) > 0"

check_sql "mobile_devices table exists" \
  "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='mobile_devices')"

check_sql "scalper_config has all expected feature-flag columns" \
  "SELECT (
     SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name='scalper_config'
       AND column_name IN (
         'adaptive_thresholds','quality_aware_sizing',
         'cht_funding_filter_enabled','mrx_funding_filter_enabled',
         'kelly_sizing_enabled'
       )
   ) = 5"

check_sql "scalper_trades.entry_price is numeric (migration 004)" \
  "SELECT EXISTS(
     SELECT 1 FROM information_schema.columns
     WHERE table_name='scalper_trades' AND column_name='entry_price' AND data_type='numeric'
   )"

check_sql "signals.quality column exists" \
  "SELECT EXISTS(
     SELECT 1 FROM information_schema.columns
     WHERE table_name='signals' AND column_name='quality'
   )"

# --- summary ----------------------------------------------------------------
printf '\n%bSummary%b\n' "$C_BOLD" "$C_RESET"
printf '  %d migration(s) applied\n' "$applied"
printf '  %d verification(s) passed\n' "$passed"
printf '  %d verification(s) failed\n' "$failed"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
