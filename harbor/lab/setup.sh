#!/usr/bin/env bash
# HARBOR lab setup: bring up regtest network, fund nodes, open channels, transact.
# Usage: ./lab/setup.sh
set -euo pipefail

COMPOSE="docker compose -f docker-compose.yml"

echo "==> Ensuring password files exist ..."
mkdir -p data
echo "password" > data/alice.pass
echo "password" > data/bob.pass  
echo "password" > data/carol.pass
chmod 600 data/*.pass

echo "==> Ensuring bitcoind wallet exists and chain is out of IBD ..."
# Bitcoin Core 32+ does not auto-create a wallet, and regtest starts at height 0
# in initial block download until blocks are mined. LND will not report
# synced_to_chain=true until the backend leaves IBD, so mine 101 blocks first.
$COMPOSE exec -T bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin \
  createwallet lab >/dev/null 2>&1 || \
  $COMPOSE exec -T bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin \
  loadwallet lab >/dev/null 2>&1 || true
TIP=$($COMPOSE exec -T bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin getblockcount 2>/dev/null | tr -d '\r')
if [ "${TIP:-0}" -lt 101 ]; then
  COINBASE_ADDR=$($COMPOSE exec -T bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin getnewaddress 2>/dev/null | tr -d '\r' | xargs)
  $COMPOSE exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin \
    generatetoaddress $((101 - TIP)) "$COINBASE_ADDR" >/dev/null
fi

echo "==> Checking LND nodes are ready ..."
for node in alice bob carol; do
  echo "   $node checking ..."
  docker ps --format '{{.Names}}' | grep -q "harbor-lnd-$node" || {
    echo "   Container not found!"
    exit 1
  }
done

echo "==> Waiting for LND nodes to be synced ..."
for node in alice bob carol; do
  port=10029
  [ "$node" = "bob" ] && port=10030
  [ "$node" = "carol" ] && port=10031
  
  for i in $(seq 1 30); do
    if docker exec harbor-lnd-${node}-1 lncli --network=regtest --rpcserver=127.0.0.1:$port getinfo 2>/dev/null | grep -q true; then
      echo "   $node synced"
      break
    fi
    sleep 2
  done
done

echo "==> Funding LND wallets from bitcoind ..."
for node in alice bob carol; do
  port=10029
  [ "$node" = "bob" ] && port=10030
  [ "$node" = "carol" ] && port=10031
  
  ADDR=$(docker exec harbor-lnd-${node}-1 lncli --network=regtest --rpcserver=127.0.0.1:$port newaddress p2wkh 2>/dev/null | jq -r .address | tr -d '\r')
  $COMPOSE exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin \
    sendtoaddress "$ADDR" 5 >/dev/null || echo "Failed to fund $node"
done

$COMPOSE exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin generatetoaddress 6 \
  "$($COMPOSE exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin getnewaddress)" >/dev/null

sleep 10

echo "==> Getting node identity pubkeys ..."
ALICE_KEY=$(docker exec harbor-lnd-alice-1 lncli --network=regtest --rpcserver=127.0.0.1:10029 getinfo 2>&1 | jq -r '.identity_pubkey')
BOB_KEY=$(docker exec harbor-lnd-bob-1 lncli --network=regtest --rpcserver=127.0.0.1:10030 getinfo 2>&1 | jq -r '.identity_pubkey')
CAROL_KEY=$(docker exec harbor-lnd-carol-1 lncli --network=regtest --rpcserver=127.0.0.1:10031 getinfo 2>&1 | jq -r '.identity_pubkey')

echo "ALICE_KEY=$ALICE_KEY"
echo "BOB_KEY=$BOB_KEY"
echo "CAROL_KEY=$CAROL_KEY"

echo "==> Connecting peers ..."
docker exec harbor-lnd-alice-1 lncli --network=regtest --rpcserver=127.0.0.1:10029 connect "$BOB_KEY@lnd-bob:9735" 2>&1 || echo "Connect alice-bob failed (may already be connected)"
docker exec harbor-lnd-bob-1 lncli --network=regtest --rpcserver=127.0.0.1:10030 connect "$CAROL_KEY@lnd-carol:9735" 2>&1 || echo "Connect bob-carol failed (may already be connected)"
docker exec harbor-lnd-alice-1 lncli --network=regtest --rpcserver=127.0.0.1:10029 connect "$CAROL_KEY@lnd-carol:9735" 2>&1 || echo "Connect alice-carol failed (may already be connected)"

mine_blocks() {
  $COMPOSE exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin generatetoaddress "$1" \
    "$($COMPOSE exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin getnewaddress)" >/dev/null
}

echo "==> Opening channels ..."
# alice-bob 2M sats
echo "   Opening alice->bob (2M sats)..."
docker exec harbor-lnd-alice-1 lncli --network=regtest --rpcserver=127.0.0.1:10029 openchannel \
  --sat_per_vbyte=10 "$BOB_KEY" 2000000 0 2>&1 | head -3 || true
mine_blocks 3

# bob-carol 1.5M sats
echo "   Opening bob->carol (1.5M sats)..."
docker exec harbor-lnd-bob-1 lncli --network=regtest --rpcserver=127.0.0.1:10030 openchannel \
  --sat_per_vbyte=10 "$CAROL_KEY" 1500000 0 2>&1 | head -3 || true
mine_blocks 3

echo "==> Waiting for channels to become active ..."
sleep 15

echo "==> Transacting over Lightning (seed liquidity for Carol) ..."
# Alice -> Bob gives Bob outbound on alice-bob; Bob -> Carol gives Carol
# outbound on bob-carol so the buyer can later pay the vendor via Bob.
# Use explicit invoices (keysend is disabled by default in lnd 0.21).
pay_invoice() {
  payer=$1; payer_port=$2; payee=$3; payee_port=$4; amt=$5
  inv=$(docker exec harbor-lnd-${payee}-1 lncli --network=regtest --rpcserver=127.0.0.1:$payee_port \
    addinvoice --amt="$amt" 2>/dev/null | jq -r .payment_request | tr -d '\r')
  docker exec harbor-lnd-${payer}-1 lncli --network=regtest --rpcserver=127.0.0.1:$payer_port \
    payinvoice --pay_req="$inv" --force --timeout=60s 2>&1 | tail -6 || true
}
pay_invoice alice 10029 bob 10030 300000
pay_invoice bob 10030 carol 10031 200000

mine_blocks 3

echo "==> Lab setup complete."
echo "    Run: ./lab/prove.sh"
echo "    Or check: docker compose ps"