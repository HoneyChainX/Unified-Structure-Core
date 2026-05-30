# Applying database migrations

SQL migrations live in `lib/db/migrations/` and are applied by
`scripts/apply-migrations.sh` — a pure-bash runner that targets any
Postgres (Supabase, RDS, self-hosted) reachable via `psql`.

## Quick start

```bash
export DATABASE_URL='postgresql://user:pass@host:5432/dbname'
./scripts/apply-migrations.sh
```

The script will:

1. Show you which database it's pointed at (host + db name, password redacted).
2. Prompt for confirmation.
3. Take a `pg_dump` backup to `./backup_YYYYMMDD_HHMMSS.sql`.
4. Apply each `*.sql` file in numeric order, each wrapped in its own transaction.
5. Run a verification block and print PASS/FAIL for each check.

## Flags

| Flag           | Effect                                                          |
| -------------- | --------------------------------------------------------------- |
| `--yes`, `-y`  | Skip the `[y/N]` confirmation. Use in CI.                       |
| `--no-backup`  | Skip the `pg_dump` backup step.                                 |
| `-h`, `--help` | Print the header comment from the script.                       |

Examples:

```bash
# fully unattended (CI)
./scripts/apply-migrations.sh --yes

# local dev where you don't care about a backup
./scripts/apply-migrations.sh --yes --no-backup
```

## Supabase notes

**Use the direct/session connection on port 5432, NOT the pooler on 6543.**

Supabase exposes two connection strings in the dashboard:

- **Direct / Session pooler — port 5432** ✓ use this one
- **Transaction pooler — port 6543** ✗ do not use for migrations

Migration `004_numeric_precision.sql` does two things the transaction pooler
cannot handle:

1. It runs `ALTER TABLE ... ALTER COLUMN ... TYPE numeric(24,12)` — a full table
   rewrite that holds an `ACCESS EXCLUSIVE` lock for the duration of the
   transaction. PgBouncer in transaction mode releases connections between
   statements and breaks the lock contract.
2. The DO-block uses prepared statements via `EXECUTE format(...)`. PgBouncer
   transaction mode does not support prepared statements.

You'll find the right URL in the Supabase dashboard under
**Project Settings → Database → Connection string → URI**, after toggling
"Use connection pooling" **off** (or selecting the *Session* mode).

## If a migration fails halfway

The runner uses `-1` (single-transaction) and `ON_ERROR_STOP=1`, so the
**failed migration itself** is rolled back automatically. Any **earlier**
migrations in the same run have already committed.

Recovery steps:

1. **Read the psql error** — it points at the exact statement that failed.
2. **Restore the pre-run backup** if you want a clean slate:
   ```bash
   psql "$DATABASE_URL" -f backup_YYYYMMDD_HHMMSS.sql
   ```
   The backup was taken with `--no-owner --no-privileges`, so it restores
   cleanly into any role.
3. **Fix the migration** in `lib/db/migrations/` (all of them are written to be
   idempotent — re-running a partially-applied one is safe).
4. **Re-run the script.** Migrations that already committed will be no-ops
   because of the `IF NOT EXISTS` / `DO $$ ... IF EXISTS ... $$` guards.

If you'd rather skip the restore and patch forward, you can apply a single
file by hand:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f lib/db/migrations/00X_name.sql
```

## Manual verification

If you ran with verification disabled (or want to double-check), paste this
into `psql`:

```sql
-- risk_config table populated
SELECT COUNT(*) FROM risk_config;

-- mobile_devices table present
SELECT to_regclass('public.mobile_devices');

-- feature-flag columns on scalper_config
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'scalper_config'
  AND column_name IN (
    'adaptive_thresholds', 'quality_aware_sizing',
    'cht_funding_filter_enabled', 'mrx_funding_filter_enabled',
    'kelly_sizing_enabled'
  )
ORDER BY column_name;

-- numeric precision applied (migration 004)
SELECT data_type
FROM information_schema.columns
WHERE table_name = 'scalper_trades' AND column_name = 'entry_price';
-- expect: numeric

-- signals.quality column present
SELECT data_type
FROM information_schema.columns
WHERE table_name = 'signals' AND column_name = 'quality';
```

All five queries should return non-empty / expected results.
