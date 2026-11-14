#!/usr/bin/env bash
# Bootstrap LND wallets with stored passwords.
# This must be run once to store wallet passwords, then docker compose up.
set -euo pipefail

HARBOR_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$HARBOR_ROOT/data"
mkdir -p "$DATA_DIR"

# Wallet passwords - MUST CHANGE THESE
# For development/regtest use only - store securely for production
ALICE_PASS="harbor-alice-dev-pass"
BOB_PASS="harbor-bob-dev-pass"
CAROL_PASS="harbor-carol-dev-pass"

# Store passwords as mountable files (gitignored)
echo -n "$ALICE_PASS" > "$DATA_DIR/alice.pass"
echo -n "$BOB_PASS" > "$DATA_DIR/bob.pass"
echo -n "$CAROL_PASS" > "$DATA_DIR/carol.pass"

chmod 600 "$DATA_DIR"/*.pass

echo "Passwords stored in $DATA_DIR/"
echo "Add $DATA_DIR/*.pass to .gitignore"
echo ""
echo "Run: docker compose up -d"