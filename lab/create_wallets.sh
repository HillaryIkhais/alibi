#!/usr/bin/env bash
# Create LND wallets with auto-unlock for regtest testing.
# This file creates the wallet if missing, then unlocks it.
set -euo pipefail

# Password for wallets
HARBOR_PASS="harbor"
PASS_FILE="/data/wallet.pass"

# Create password file
echo "$HARBOR_PASS" > "$PASS_FILE"
chmod 600 "$PASS_FILE"

for NODE in alice bob carol; do
  echo "==> Setting up $NODE wallet ..."
  # Copy password file into container
  docker cp "$PASS_FILE" "harbor-lnd-$NODE-1:/data/wallet.pass" 2>/dev/null || true
  # Unlock the wallet
  docker exec "harbor-lnd-$NODE-1" lncli --network=regtest unlock --wallet-unlock-password-file=/data/wallet.pass 2>&1 || true
done

rm -f "$PASS_FILE"