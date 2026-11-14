#!/usr/bin/env bash
# Run the HARBOR auditor against a live LND node (default: lnd-alice on port 10039).
# Extracts the admin macaroon from the container and runs the audit.
set -euo pipefail

NODE="${1:-lnd-alice}"
PORT="${2:-10039}"
OFFSITE="${3:-}"

echo "==> Extracting admin macaroon from $NODE ..."
MACAROON_HEX=$(docker compose exec "$NODE" xxd -p ~/.lnd/admin.macaroon | tr -d '\n')
if [ -z "$MACAROON_HEX" ]; then
  echo "Could not read admin.macaroon from $NODE" >&2
  exit 1
fi

export HARBOR_LND_REST_URL="http://localhost:$PORT"
export HARBOR_LND_MACAROON="$MACAROON_HEX"
export HARBOR_LAB_MODE=1
if [ -n "$OFFSITE" ]; then
  export HARBOR_OFFSITE_BACKUP="$OFFSITE"
fi

echo "==> Running HARBOR audit against $NODE ..."
cd "$(dirname "$0")/../auditor"
node bin/audit.mjs
