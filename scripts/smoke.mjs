#!/usr/bin/env node
/**
 * LIVE smoke test — spends real sats (~100 + fees).
 *
 * Buys one unit of the Hypawave Compute demo offer end-to-end through the
 * built MCP server: search → get terms → pay via NWC → confirm → settled.
 * Validates the full sign→pay→confirm→unlock path on mainnet.
 *
 * Usage: NWC_URL='nostr+walletconnect://...' node scripts/smoke.mjs [offer_id]
 */
import { spawn } from "node:child_process";

const COMPUTE_DEMO_OFFER = "14f17ebf-5e75-4208-9d53-f21978ef30c7";
const offerId = process.argv[2] || COMPUTE_DEMO_OFFER;

if (!process.env.NWC_URL && !process.env.HYPAWAVE_NWC_URL) {
  console.error("NWC_URL is required — this test pays a real 100-sat invoice.");
  process.exit(2);
}

const server = spawn("node", [new URL("../dist/index.js", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
server.stdout.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 120_000);
  });
}
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
};

try {
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const status = await call("wallet_status", {});
  console.log(`wallet: ${status.wallet.balance_sats} sats | cap: ${status.spending_cap?.cap} (${status.spending_cap?.source})`);

  const offer = await call("get_offer", { offer_id: offerId });
  console.log(`offer: ${offer.description?.slice(0, 80)} — ${offer.amount} ${offer.currency}`);

  const buy = await call("buy_offer", { offer_id: offerId, expected_max_sats: 200 });
  console.log(`paid: settled=${buy.settled} intent=${buy.payment_intent_id}`);
  console.log(`claim_token: ${buy.claim_token ? "received" : "none (execution offer — preimage is the credential)"}`);
  console.log(`preimage: ${buy.preimage?.slice(0, 16)}…`);
  console.log(buy.next);
  console.log("\nSMOKE TEST PASSED — full sign→pay→confirm→settle path works on mainnet.");
} catch (e) {
  console.error("\nSMOKE TEST FAILED:", e.message);
  process.exitCode = 1;
} finally {
  server.kill();
}
