#!/bin/bash
# LND entrypoint that creates wallet on first run and exports seed
# Called as: lnd --wallet-unlock-password-file=... --wallet-unlock-allow-create ...

set -e

LND_DATA="/root/.lnd"
SEED_FILE="/harbor-data/alice.seed"
PASS_FILE="/harbor-data/alice.pass"

# Wait for LND to be ready
sleep 2

# Check if wallet exists (has .lnd/data/chain/bitcoin/regtest/admin.macaroon)
if [ ! -f "$LND_DATA/data/chain/bitcoin/regtest/admin.macaroon" ]; then
    echo "=== Wallet not found, creating new wallet ==="
    
    # Wait a moment for LND to initialize
    sleep 5
    
    # Create wallet with password
    lncli --network=regtest createwallet --password="$(cat $PASS_FILE)" harbormerchant
    
    # Export the seed immediately
    SEED=$(lncli --network=regtest exportmonderseed --password="$(cat $PASS_FILE)" 2>/dev/null || \
           lncli --network=regtest exportchangelistseed --password="$(cat $PASS_FILE)" 2>/dev/null || \
           echo "")
    
    if [ -n "$SEED" ] && [ "$SEED" != "" ]; then
        echo "$SEED" > "$SEED_FILE"
        chmod 600 "$SEED_FILE"
        echo "=== Wallet created, seed exported to $SEED_FILE ==="
        echo "$SEED"
    else
        echo "WARNING: Could not export seed"
    fi
else
    echo "=== Wallet already exists, unlocking with password ==="
fi

# Now exec lnd with all arguments passed to this script
exec lnd "$@"