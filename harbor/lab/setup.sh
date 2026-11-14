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
  
  ADDR=$(docker exec harbor-lnd-${node}-1 lncli --network=regtest --rpcserver=127.0.0.1:$port newaddress p2wkh 2>&1 | grep -o '"address":"[^"]*"' | cut -d'"' -f4)
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
docker exec harbor-lnd-alice-1 lncli --network=regtest --rpcserver=127.0.0.1:10029 connect "$BOB_KEY@lnd-bob-1:9735" 2>&1 || echo "Connect alice-bob failed (may already be connected)"
docker exec harbor-lnd-bob-1 lncli --network=regtest --rpcserver=127.0.0.1:10030 connect "$CAROL_KEY@lnd-carol-1:9735" 2>&1 || echo "Connect bob-carol failed (may already be connected)"
docker exec harbor-lnd-alice-1 lncli --network=regtest --rpcserver=127.0.0.1:10029 connect "$CAROL_KEY@lnd-carol-1:9735" 2>&1 || echo "Connect alice-carol failed (may already be connected)"

echo "==> Opening channels ..."
# alice-bob 2M sats
echo "   Opening alice->bob (2M sats)..."
docker exec harbor-lnd-alice-1 lncli --network=regtest --rpcserver=127.0.0.1:10029 openchannel \
  --node_pubkey="$BOB_KEY" --local_amt=2000000 2>&1 | head -3 || true

# bob-carol 1.5M sats
echo "   Opening bob->carol (1.5M sats)..."
docker exec harbor-lnd-bob-1 lncli --network=regtest --rpcserver=127.0.0.1:10030 openchannel \
  --node_pubkey="$CAROL_KEY" --local_amt=1500000 2>&1 | head -3 || true

# alice-carol 1M sats
echo "   Opening alice->carol (1M sats)..."
docker exec harbor-lnd-alice-1 lncli --network=regtest --rpcserver=127.0.0.1:10029 openchannel \
  --node_pubkey="$CAROL_KEY" --local_amt=1000000 2>&1 | head -3 || true

# Mine more blocks for channel confirms
$COMPOSE exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin generatetoaddress 6 \
  "$($COMPOSE exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin getnewaddress)" >/dev/null

echo "==> Waiting for channels to become active ..."
sleep 15

echo "==> Transacting over Lightning ..."
docker exec harbor-lnd-alice-1 lncli --network=regtest --rpcserver=127.0.0.1:10029 sendpayment \
  --dest="$BOB_KEY" --amt=300000 2>&1 | head -3 || true
docker exec harbor-lnd-bob-1 lncli --network=regtest --rpcserver=127.0.0.1:10030 sendpayment \
  --dest="$CAROL_KEY" --amt=200000 2>&1 | head -3 || true

$COMPOSE exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin generatetoaddress 3 \
  "$($COMPOSE exec bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin getnewaddress)" >/dev/null

echo "==> Lab setup complete."
echo "    Run: ./lab/prove.sh"
echo "    Or check: docker compose ps"