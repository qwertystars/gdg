#!/usr/bin/env bash
# Create D1 migration files with the right sequence prefix.
#
# Usage:
#   bun run scripts/migration:new -- <name>
#   scripts/migration-new.sh <name>
#
# Wrangler applies D1 migrations in filename order, so every file needs a
# zero-padded sequence number. This script writes an empty numbered file
# under migrations/ and prints the path.

set -euo pipefail

name="${1:-}"
if [[ -z "$name" ]]; then
  echo "usage: $0 <migration-name>" >&2
  exit 2
fi
if [[ ! "$name" =~ ^[a-z0-9_]+$ ]]; then
  echo "error: migration name must be lowercase snake_case (got '$name')" >&2
  exit 2
fi

migrations_dir="migrations"
mkdir -p "$migrations_dir"

next=""
if compgen -G "$migrations_dir"/[0-9][0-9][0-9][0-9]_*.sql >/dev/null; then
  latest=$(ls "$migrations_dir"/[0-9][0-9][0-9][0-9]_*.sql | sort | tail -n 1)
  base=$(basename "$latest")
  seq=${base%%_*}
  next=$(printf "%04d" $((10#$seq + 1)))
else
  next="0001"
fi

file="$migrations_dir/${next}_${name}.sql"
if [[ -e "$file" ]]; then
  echo "error: $file already exists" >&2
  exit 1
fi

cat > "$file" <<'EOF'
-- Describe this migration in one line.
EOF
echo "created $file"
