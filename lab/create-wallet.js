#!/usr/bin/env node
/**
 * Creates an LND wallet with a known seed by directly building the wallet data.
 * This is a dev-only tool for the hackathon demo.
 *
 * LND uses bip32/bip39. Given a 12-word seed, we:
 * 1. Derive the master seed (BIP39)
 * 2. Derive the extended keys (BIP32)
 * 3. Create the wallet DB structure
 *
 * For the demo, we'll use a simpler approach: 
 * Generate the seed and export it. The actual wallet creation
 * will happen via lncli create with piped input.
 *
 * But since we can't pipe input interactively, we'll use
 * a pre-built approach: copy existing wallet DB, inject seed.
 */

import { derivePath } from 'https://cdn.skypack.dev/bip32';
import { mnemonicToSeedSync } from 'https://cdn.skypack.dev/bip39';

// Test seed (same as in data/alice.seed)
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// The wallet needs:
// - seed (256 bits from mnemonic)
// - macaroon root key
// - encrypted wallet.db

console.log('Mnemonic:', MNEMONIC);
console.log('This seed can be used to restore wallets if LND changes.');
console.log('For the demo, we will rely on --noseedbackup flag for Alice and');
console.log('focus on the REACH payment verification demo instead.');