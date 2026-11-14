#!/usr/bin/env node
/**
 * REACH - Lightning Payment Recovery Engine
 * 
 * Prepay probe for route verification before payment.
 * Uses LND's router API to test if a payment can succeed
 * before the customer commits.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const HARBOR_LND_REST_URL = process.env.HARBOR_LND_REST_URL || "http://localhost:10039";
const HARBOR_LND_MACAROON = process.env.HARBOR_LND_MACAROON || "";

function getRestUrl() { return HARBOR_LND_REST_URL; }
function getMacaroon() { return HARBOR_LND_MACAROON; }

function getHeaders() {
  return {
    "Grpc-Metadata-macaroon": getMacaroon(),
    "Content-Type": "application/json",
  };
}

function isHttps(url) { return url.startsWith('https:'); }

async function fetchJson(path, method = 'GET', body = null) {
  const urlObj = new URL(getRestUrl());
  const requestModule = isHttps(urlObj.protocol) ? https : http;
  
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (isHttps(urlObj.protocol) ? 443 : 80),
    path: path + urlObj.search,
    method: method,
    headers: getHeaders(),
    ...(isHttps(urlObj.protocol) ? { rejectUnauthorized: false } : {})
  };

  const requestBody = body ? JSON.stringify(body) : null;
  options.body = requestBody;

  return new Promise((resolve, reject) => {
    const req = requestModule.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        }
      });
    });
    req.on('error', reject);
    if (requestBody) req.write(requestBody);
    req.end();
  });
}

/**
 * Perform a prepay probe to test if a payment can succeed.
 * Returns the probe result with success/failure status.
 */
export async function prepayProbe({
  destination_pubkey,
  amount_sat,
  max_fee_sat = 1000,
  timeout_seconds = 30,
}) {
  // Generate a random payment hash for the probe
  const paymentHash = crypto.randomBytes(32).toString('hex');
  
  try {
    // Use the router API to probe the route
    // In LND v0.21, we use the payinvoice endpoint with a dummy invoice
    // to test routing. The actual result comes from the error message.
    
    // First, check if we can build a route to the destination
    const route = await fetchJson(
      `/v1/router/findroute?pubkey=${destination_pubkey}&amt=${amount_sat * 1000}&fee_limit=${max_fee_sat * 1000}&final_cltv_delta=144`,
      'GET'
    );

    if (route && route.routes && route.routes.length > 0) {
      return {
        success: true,
        route_found: true,
        route: route.routes[0],
        fee_sat: (route.routes[0].total_fees || 0) / 1000,
        payment_hash: paymentHash,
        reason: "Route found successfully",
      };
    } else {
      return {
        success: false,
        route_found: false,
        reason: "No viable route found",
      };
    }
  } catch (e) {
    // Parse the error to determine failure reason
    const errorMsg = e.message.toLowerCase();
    
    if (errorMsg.includes('no route to destination') || errorMsg.includes('routing failure')) {
      return {
        success: false,
        route_found: false,
        reason: "No route to destination",
        error_code: "NO_ROUTE",
      };
    }
    
    if (errorMsg.includes('insufficient') && errorMsg.includes('capacity')) {
      return {
        success: false,
        route_found: false,
        reason: "Insufficient liquidity in required direction",
        error_code: "INSUFFICIENT_CAPACITY",
      };
    }
    
    if (errorMsg.includes('timeout') || errorMsg.includes('timed out')) {
      return {
        success: false,
        route_found: false,
        reason: "Route probe timed out",
        error_code: "TIMEOUT",
      };
    }
    
    return {
      success: false,
      route_found: false,
      reason: "Unknown routing failure",
      error: e.message,
    };
  }
}

/**
 * Get channel information for a specific channel point.
 */
export async function getChannelInfo({ channel_point }) {
  try {
    const chanId = channel_point.split(':')[0];
    const chan = await fetchJson(`/v1/channels/${chanId}`, 'GET');
    return chan;
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Get wallet balance.
 */
export async function getWalletBalance() {
  try {
    const balance = await fetchJson('/v1/walletbalance', 'GET');
    return balance;
  } catch (e) {
    return { error: e.message };
  }
}

// CLI entry point
if (process.argv[1] === import.meta.url) {
  const [, , destKey, amtStr] = process.argv;
  
  if (!destKey || !amtStr) {
    console.error("Usage: node reach-probe.mjs <destination_pubkey> <amount_sat>");
    process.exit(1);
  }
  
  const result = await prepayProbe({
    destination_pubkey: destKey,
    amount_sat: parseInt(amtStr, 10),
  });
  
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}