#!/usr/bin/env node
/**
 * HARBOR safe-exit decision engine (VECT-aligned).
 *
 * Given a channel classification, compares the available intervention paths
 * and their consequences. The planner recommends; the operator approves;
 * nothing executes automatically.
 *
 * Paths:
 *   A. wait_and_reconnect   — preserve channel, continue observing, no on-chain cost
 *   B. cooperative_close    — both parties sign, no CSV delay, needs available peer
 *   C. force_close          — unilateral broadcast, fee + CSV delay, operator approval
 *
 * The force-close option does not automatically win because a peer has been
 * offline. The planner explains trade-offs and states when evidence is
 * insufficient to recommend intervention.
 *
 * Env:
 *   HARBOR_FEE_SATS_PER_VBYTE   default 5
 *   HARBOR_CSV_DELAY_BLOCKS     default 144
 */

import fs from "node:fs";

function fail(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

function nowIso() {
  return new Date().toISOString();
}

const FEE_SATS_PER_VBYTE = Number(process.env.HARBOR_FEE_SATS_PER_VBYTE) || 5;
const CSV_DELAY_BLOCKS = Number(process.env.HARBOR_CSV_DELAY_BLOCKS) || 144;

const V_SIZE = {
  cooperative_close: 220,
  force_close: 260,
  force_close_with_htlc: 340,
  sweep_after_csv: 190,
};

function sats(vbytes) {
  return BigInt(Math.ceil(vbytes * FEE_SATS_PER_VBYTE));
}

function nowPlusBlocks(blocks) {
  // Regtest-agnostic: return a notional confirmation target.
  return blocks;
}

export function planExit(channel, options = {}) {
  const {
    peerReachable = channel.peer_online === true,
    pendingHtlcs = channel.pending_htlcs || 0,
    localBalance = BigInt(channel.local_balance || 0),
    channelCapacity = BigInt(channel.capacity || 0),
  } = options;

  const state = channel.state;
  const paths = [];
  let recommendedPath = null;
  let recommendationBasis = null;

  // ---------- Path A: Wait and reconnect ----------
  paths.push({
    id: "wait_and_reconnect",
    label: "Wait and reconnect",
    description:
      "Preserve the channel and continue observing peer availability. No immediate on-chain closure cost. Recovery dependency remains — if the node is lost while the peer is unreachable, SCB recovery depends on DLP cooperation.",
    on_chain_cost_sats: "0",
    csv_delay_blocks: 0,
    requires_peer: false,
    requires_operator_approval: false,
    preconditions: ["Continue peer-availability observations."],
    trade_offs: {
      advantage: "No closure cost; channel remains operational.",
      disadvantage:
        "Recovery dependency remains unverified while the peer is absent.",
    },
  });

  // ---------- Path B: Cooperative close ----------
  const cooperativeFee = sats(V_SIZE.cooperative_close);
  paths.push({
    id: "cooperative_close",
    label: "Cooperative close",
    description:
      "Both parties sign a closing transaction; funds return to on-chain outputs without CSV delay. Avoids unilateral closure if successful.",
    on_chain_cost_sats: cooperativeFee.toString(),
    csv_delay_blocks: 0,
    requires_peer: true,
    requires_operator_approval: true,
    preconditions: [
      "Peer is online and able to sign the closing transaction.",
      "Operator reviews and approves the closing transaction and fee.",
      "Closing transaction confirmed on-chain.",
    ],
    available: peerReachable,
    trade_offs: {
      advantage:
        "No CSV delay; cleanest on-chain exit when the peer can cooperate.",
      disadvantage: "Requires an available, cooperating peer.",
    },
  });

  // ---------- Path C: Force close ----------
  const forceFee = sats(
    pendingHtlcs > 0
      ? V_SIZE.force_close_with_htlc
      : V_SIZE.force_close
  );
  paths.push({
    id: "force_close",
    label: "Force close",
    description:
      "Broadcast the latest local commitment unilaterally. On-chain fee and CSV delay apply. Pending HTLCs require separate resolution. Local outputs remain locked until CSV maturity, then swept.",
    on_chain_cost_sats: forceFee.toString(),
    csv_delay_blocks: CSV_DELAY_BLOCKS,
    requires_peer: false,
    requires_operator_approval: true,
    preconditions: [
      "Operator approves force-close after reviewing fees and timelock delay.",
      "Force-close transaction broadcast and confirmed on-chain.",
      `Wait ${CSV_DELAY_BLOCKS} blocks for CSV maturity before sweep.`,
      "Sweep transaction broadcast and confirmed.",
      pendingHtlcs > 0
        ? `Resolve ${pendingHtlcs} pending HTLC(s) separately after force-close.`
        : null,
    ].filter(Boolean),
    trade_offs: {
      advantage:
        "Does not depend on peer cooperation; can proceed while the node is operational.",
      disadvantage:
        "On-chain fee, CSV delay, and pending-HTLC resolution add cost and complexity.",
    },
  });

  // ---------- Recommendation logic ----------
  // Force-close never auto-wins. Recommendation depends on state and evidence.
  if (state === "BACKUP_MISSING") {
    recommendedPath = null;
    recommendationBasis =
      "No backup entry exists. Refresh the offsite backup and re-audit before any exit decision.";
  } else if (state === "AWAITING_FUNDING_CONFIRMATION") {
    recommendedPath = null;
    recommendationBasis =
      "Channel not yet fully established. Wait for funding confirmation; no exit intervention yet.";
  } else if (state === "BACKED_UP_PEER_RECENTLY_SEEN") {
    recommendedPath = "wait_and_reconnect";
    recommendationBasis =
      "Backup covers the channel and the peer was recently observed. Continue monitoring; no intervention warranted.";
  } else if (state === "BACKED_UP_PEER_UNVERIFIED") {
    // Peer not recently observed. Weigh paths based on evidence quality.
    if (!peerReachable && hoursSinceLastConnectionIsLarge(channel)) {
      // Peer persistently absent and channel has meaningful local balance:
      // force close is defensible but not automatic.
      recommendedPath = "force_close";
      recommendationBasis =
        "Peer persistently unavailable and channel holds local balance. Force close removes the recovery dependency while the node is operational. Requires operator approval.";
    } else if (peerReachable) {
      recommendedPath = "cooperative_close";
      recommendationBasis =
        "Peer is reachable. Cooperative close avoids unilateral closure cost and CSV delay.";
    } else {
      recommendedPath = "wait_and_reconnect";
      recommendationBasis =
        "Available evidence is insufficient to justify intervention. Continue observing peer availability; revisit if the pattern persists.";
    }
  }

  return {
    channel_point: channel.channel_point,
    chan_id: channel.chan_id,
    capacity: channelCapacity.toString(),
    local_balance: localBalance.toString(),
    plan_id: `harbor-exit-${channel.chan_id}-${Date.now()}`,
    created_at: nowIso(),
    state,
    peer_reachable: peerReachable,
    pending_htlcs: pendingHtlcs,
    paths,
    recommended_path: recommendedPath,
    recommendation_basis: recommendationBasis,
    requires_operator_approval:
      recommendedPath
        ? paths.find((p) => p.id === recommendedPath)?.requires_operator_approval ||
          false
        : false,
    status: "proposed",
  };
}

function hoursSinceLastConnectionIsLarge(channel) {
  const h = channel.hours_since_last_connection;
  return h !== null && h > 72; // more than 3 days without a connection observation
}

if (process.argv[1] === import.meta.url) {
  const [channelJsonPath] = process.argv.slice(2);
  if (!channelJsonPath)
    fail("Usage: node exit-planner.mjs <channel-classification-json>");
  const channel = JSON.parse(fs.readFileSync(channelJsonPath, "utf8"));
  const plan = planExit(channel);
  console.log(JSON.stringify(plan, null, 2));
}
