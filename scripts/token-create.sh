#!/usr/bin/env bash
# Create a fresh API token for local development or the event.
#
# The token is created in one of two ways:
#
#   1. Full mode (default): connect to D1, insert a hashed token row for a
#      known participant, and print the plaintext token once. Requires
#      `bun run db:migrate` first and the seeded participant to exist.
#
#   2. Offline mode (--offline): print a random token and the SHA-256 hash
#      plus SQL snippet to insert by hand. No database connection needed.
#
# A token hash is the only thing stored anywhere. The plaintext token is
# printed once and then discarded. Keep it secret.
#
# Usage:
#   bun run scripts/token:create -- <participant-id> [--role ADMIN] [--offline]

set -euo pipefail

role="PARTICIPANT"
offline=0
participant_id=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)
      role="${2:-}"
      shift 2
      ;;
    --offline)
      offline=1
      shift
      ;;
    -h|--help)
      echo "usage: $0 <participant-id> [--role PARTICIPANT|ADMIN] [--offline]"
      exit 0
      ;;
    *)
      participant_id="$1"
      shift
      ;;
  esac
done

if [[ -z "$participant_id" ]]; then
  echo "usage: $0 <participant-id> [--role PARTICIPANT|ADMIN] [--offline]" >&2
  exit 2
fi

if [[ "$role" != "PARTICIPANT" && "$role" != "ADMIN" ]]; then
  echo "error: role must be PARTICIPANT or ADMIN" >&2
  exit 2
fi

# 32 random bytes, URL-safe base64, no padding. Equivalent to 256 bits.
token=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
hash=$(printf '%s' "$token" | sha256sum | awk '{print $1}')

if [[ "$offline" == "1" ]]; then
  echo "token      : $token"
  echo "token_hash : $hash"
  echo
  echo "Insert manually (never store the plaintext token):"
  echo "  INSERT INTO api_tokens (id, participant_id, token_hash, role, created_at)"
  echo "  VALUES ('tok_$(date +%s)', '$participant_id', '$hash', '$role', CURRENT_TIMESTAMP);"
  exit 0
fi

if ! command -v wrangler >/dev/null 2>&1; then
  echo "error: wrangler not found; run with --offline or install wrangler" >&2
  exit 1
fi

id="tok_$(date +%s)_${participant_id}"
sql="INSERT INTO api_tokens (id, participant_id, token_hash, role, created_at)
     VALUES ('$id', '$participant_id', '$hash', '$role', CURRENT_TIMESTAMP);"

wrangler d1 execute DB --remote --command "$sql"

echo
echo "Created token for participant $participant_id with role $role."
echo "token      : $token"
echo "token_hash : $hash"
echo "Store the plaintext token somewhere safe; only the hash is kept in D1."
