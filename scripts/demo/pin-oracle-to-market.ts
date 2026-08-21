/**
 * Pin the testnet MockPool oracle to the live OKX spot markets, so the demo tokens
 * (xETH, xBTC, WOKB) track real prices instead of stale placeholders. Run whenever the
 * demo drifts from the market; the dApp lab shows the live tickers next to these.
 *
 * Env: DEPLOYER_PRIVATE_KEY (MockPool owner), POOL_ADDRESS_TESTNET,
 *      XETH_ADDRESS_TESTNET, XBTC_ADDRESS_TESTNET, WOKB_ADDRESS_TESTNET,
 *      XLAYER_TESTNET_RPC_URL (optional).
 * Usage: pnpm tsx scripts/demo/pin-oracle-to-market.ts [--dry]
 */
import "dotenv/config";
import { createPublicClient, createWalletClient, formatUnits, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xlayerTestnet } from "../../src/chains/xlayer.js";
import { MOCK_POOL_ABI } from "../../src/guard/abi.js";

const DRY = process.argv.includes("--dry");
const env = (k: string) => process.env[k] ?? "";
const POOL = env("POOL_ADDRESS_TESTNET") as Address;
const KEY = env("DEPLOYER_PRIVATE_KEY") as Hex;
const RPC = env("XLAYER_TESTNET_RPC_URL") || "https://testrpc.xlayer.tech";
if (!POOL || !KEY) {
  console.error("missing POOL_ADDRESS_TESTNET or DEPLOYER_PRIVATE_KEY");
  process.exit(1);
}

const ASSETS: { envKey: string; symbol: string; instId: string }[] = [
  { envKey: "XETH_ADDRESS_TESTNET", symbol: "xETH", instId: "ETH-USDT" },
  { envKey: "XBTC_ADDRESS_TESTNET", symbol: "xBTC", instId: "BTC-USDT" },
  { envKey: "WOKB_ADDRESS_TESTNET", symbol: "WOKB", instId: "OKB-USDT" },
];

const publicClient = createPublicClient({ chain: xlayerTestnet, transport: http(RPC) });
const wallet = createWalletClient({
  account: privateKeyToAccount(KEY),
  chain: xlayerTestnet,
  transport: http(RPC),
});

async function marketPrice(instId: string): Promise<number> {
  const res = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`);
  const body = (await res.json()) as { data?: { last?: string }[] };
  const last = Number(body.data?.[0]?.last);
  if (!Number.isFinite(last) || last <= 0) throw new Error(`bad OKX price for ${instId}`);
  return last;
}

for (const { envKey, symbol, instId } of ASSETS) {
  const asset = env(envKey) as Address;
  if (!asset) {
    console.warn(`skip ${symbol}: ${envKey} unset`);
    continue;
  }
  const [market, current] = await Promise.all([
    marketPrice(instId),
    publicClient.readContract({ address: POOL, abi: MOCK_POOL_ABI, functionName: "getAssetPrice", args: [asset] }),
  ]);
  // MockPool prices are 8-decimal USD; round the spot to whole cents to keep them tidy.
  const next = BigInt(Math.round(market * 100)) * 10n ** 6n;
  const cur = Number(formatUnits(current as bigint, 8));
  console.log(`${symbol}: oracle ${cur} -> market ${market}`);
  if (DRY || next === (current as bigint)) continue;
  const hash = await wallet.writeContract({
    address: POOL,
    abi: MOCK_POOL_ABI,
    functionName: "setPrice",
    args: [asset, next],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  setPrice tx ${hash}`);
}
console.log(DRY ? "dry run — nothing sent" : "oracle pinned to market");
