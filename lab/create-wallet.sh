#!/bin/bash
# Non-interactive wallet creation script
export LC_ALL=C
# Use printf to feed password
printf "testpass123\ntestpass123\n" | lncli --network=regtest create --stateless_init --save_to=/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon
