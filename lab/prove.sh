#!/usr/bin/env bash
# HARBOR recovery drill (regtest).
#
# Demonstrates the actual failure mechanism deterministically:
#   1. Capture the node's current channel.backup (live hash) + take an offsite copy.
#   2. Open NEW channels after the offsite copy is taken.
#   3. Recompute the live channel.backup hash -> it now differs from the offsite
#      copy (offsite backup is STALE). HARBOR reports offsite_stale=true.
#   4. Run the auditor -> per-channel coverage + peer status findings.
#   5. Refresh the offsite copy -> re-audit -> offsite_stale=false.
#
# Observed facts only. No mainnet, no secrets, no peer-cooperation claims.
#
# Usage: ./lab/prove.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Verify lab is running
docker compose ps --services 2>/dev/null | grep -q bitcoind || {
  echo "Lab not running. Run: ./lab/setup.sh" >&2
  exit 1
}

# Get macaroon
MACAROON=$(docker exec harbor-lnd-alice-1 xxd -p /root/.lnd/data/chain/bitcoin/regtest/admin.macaroon 2>/dev/null | tr -d '\n' || echo "$HARBOR_LND_MACAROON")

# Export channel.backup from container if not present
if [[ ! -f data/channel.backup ]] && docker exec harbor-lnd-alice-1 test -f /root/.lnd/data/chain/bitcoin/regtest/channel.backup 2>/dev/null; then
  docker exec harbor-lnd-alice-1 cat /root/.lnd/data/chain/bitcoin/regtest/channel.backup > data/channel.backup
fi

echo "==> Step 1: capture baseline + take offsite backup copy"
LIVE_HASH=$(docker exec harbor-lnd-alice-1 sha256sum /root/.lnd/data/chain/bitcoin/regtest/channel.backup 2>/dev/null | awk '{print $1}')
cp data/channel.backup data/channel.offsite.backup 2>/dev/null || true
export HARBOR_LND_REST_URL="https://127.0.0.1:10039"
export HARBOR_LND_MACAROON="$MACAROON"
export HARBOR_LAB_MODE=1
export HARBOR_OFFSITE_BACKUP="$PWD/data/channel.offsite.backup"
export HARBOR_LIVE_BACKUP_HASH="$LIVE_HASH"
echo "   Live hash: $LIVE_HASH"

BASELINE=$(cd auditor && node bin/audit.mjs 2>/dev/null)
echo "$BASELINE" | jq '{stage: "baseline", total_channels, backup_entry_count, covered_count, uncovered_count, offsite_stale: .offsite_backup.stale}'
cd ..

echo "==> Step 2: Open ONE new channel after offsite copy was taken"
ALICE_KEY=$(docker exec harbor-lnd-alice-1 lncli --network=regtest --rpcserver=127.0.0.1:10029 getinfo 2>/dev/null | jq -r '.identity_pubkey')
BOB_KEY=$(docker exec harbor-lnd-bob-1 lncli --network=regtest --rpcserver=127.0.0.1:10030 getinfo 2>/dev/null | jq -r '.identity_pubkey')

# Open new channel alice->bob: 500k sats
docker exec harbor-lnd-alice-1 lncli --network=regtest --rpcserver=127.0.0.1:10029 openchannel $BOB_KEY 500000 2>&1 | head -3 || true

# Mine blocks for confirmation
docker compose exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin generatetoaddress 6 "$(docker compose exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin getnewaddress)" >/dev/null 2>&1 || true

sleep 10

echo "==> Step 3: offsite backup is now STALE (hash differs from live channel.backup)"
LIVE2=$(docker exec harbor-lnd-alice-1 sha256sum /root/.lnd/data/chain/bitcoin/regtest/channel.backup 2>/dev/null | awk '{print $1}')
export HARBOR_LIVE_BACKUP_HASH="$LIVE2"
echo "   Live hash: $LIVE2"
echo "   Offsite hash: $(sha256sum data/channel.offsite.backup 2>/dev/null | awk '{print $1}')"

STALE=$(cd auditor && node bin/audit.mjs 2>/dev/null)
echo "$STALE" | jq '{stage: "stale-offsite-backup", total_channels, backup_entry_count, covered_count, uncovered_count, offsite_stale: .offsite_backup.stale}'

echo "==> Step 4: refresh the offsite copy to match the live node"
docker exec harbor-lnd-alice-1 cat /root/.lnd/data/chain/bitcoin/regtest/channel.backup > data/channel.fresh.backup 2>/dev/null || true
export HARBOR_OFFSITE_BACKUP="$PWD/data/channel.fresh.backup"
export HARBOR_LIVE_BACKUP_HASH="$(docker exec harbor-lnd-alice-1 sha256sum /root/.lnd/data/chain/bitcoin/regtest/channel.backup 2>/dev/null | awk '{print $1}')"

FRESH=$(cd auditor && node bin/audit.mjs 2>/dev/null)
echo "$FRESH" | jq '{stage: "refreshed-offsite-backup", total_channels, backup_entry_count, covered_count, uncovered_count, offsite_stale: .offsite_backup.stale}'

echo ""
echo "==> DRILL RESULT =="
echo "$STALE" | jq '{drill: "stale offsite backup", offsite_stale: .offsite_backup.stale, total_channels: .total_channels, covered_count: .covered_count}'
echo "$FRESH" | jq '{drill: "after refreshing backup", offsite_stale: .offsite_backup.stale, total_channels: .total_channels, covered_count: .covered_count}'