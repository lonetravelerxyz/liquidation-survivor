import { getAddress, type Address } from "viem";
import { config } from "../config.js";
import { MAINNET_ORACLE, MAINNET_RESERVES } from "../chains/xlayer.js";
import { AAVE_ORACLE_ABI, AAVE_POOL_ABI, ERC20_ABI, MOCK_POOL_ABI } from "../guard/abi.js";
import { mapLimit, publicClient } from "../guard/client.js";
import {
  baseToUsd,
  formatUnitsStr,
  hfToNumber,
  liquidationPrices,
  tokenUsd,
  type LiquidationPriceHint,
} from "./math.js";

export interface ReserveInfo {
  symbol: string;
  address: Address; // lowercase
  decimals: number;
  aToken: Address;
  vToken: Address;
  priceUsd: number;
  /** stablecoin → usable as the repayment buffer */
  isStable: boolean;
  liquidationThresholdBps?: number;
  ltvBps?: number;
}

export interface ReservePosition extends ReserveInfo {
  supplied: string; // token units, decimal string
  borrowed: string;
  suppliedRaw: bigint;
  borrowedRaw: bigint;
  suppliedUsd: number;
  borrowedUsd: number;
}

export interface Position {
  address: Address;
  chain: "mainnet" | "testnet";
  collateralUsd: number;
  debtUsd: number;
  /** Infinity when the account has no debt */
  hf: number;
  hfRaw: bigint;
  liquidationThresholdBps: number;
  ltvBps: number;
  reserves: ReservePosition[];
  liquidationPriceHints: LiquidationPriceHint[];
  fetchedAt: number;
}

const STABLE_SYMBOLS = new Set(["USDT", "USDC", "USDG", "GHO", "DAI", "USDE", "USD₮0"]);
const CONCURRENCY = 4;

const poolAddress = (): Address => {
  if (!config.poolAddress) throw new Error("pool address not configured");
  return config.poolAddress;
};

// ------------------------------------------------------------------ caches (cheap RPC hygiene)
interface Cached<T> {
  at: number;
  value: T;
}
let reservesCache: Cached<ReserveInfo[]> | null = null;
const tokenMetaCache = new Map<string, { symbol: string; decimals: number }>();
const RESERVES_TTL_MS = 20_000;

async function tokenMeta(token: Address): Promise<{ symbol: string; decimals: number }> {
  const key = token.toLowerCase();
  const hit = tokenMetaCache.get(key);
  if (hit) return hit;
  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
  ]);
  const meta = { symbol, decimals: Number(decimals) };
  tokenMetaCache.set(key, meta);
  return meta;
}

// ------------------------------------------------------------------ reserves
async function mainnetReserves(): Promise<ReserveInfo[]> {
  const assets = MAINNET_RESERVES.map((r) => r.address);
  let prices: readonly bigint[] = [];
  try {
    prices = await publicClient.readContract({
      address: MAINNET_ORACLE,
      abi: AAVE_ORACLE_ABI,
      functionName: "getAssetsPrices",
      args: [assets],
    });
  } catch {
    prices = await mapLimit(assets, CONCURRENCY, (a) =>
      publicClient.readContract({
        address: MAINNET_ORACLE,
        abi: AAVE_ORACLE_ABI,
        functionName: "getAssetPrice",
        args: [a],
      }),
    );
  }
  return MAINNET_RESERVES.map((r, i) => ({
    symbol: r.symbol,
    address: r.address.toLowerCase() as Address,
    decimals: r.decimals,
    aToken: r.aToken,
    vToken: r.vToken,
    priceUsd: baseToUsd(prices[i] ?? 0n),
    isStable: r.stable,
  }));
}

async function testnetReserves(): Promise<ReserveInfo[]> {
  const pool = poolAddress();
  const list = await publicClient.readContract({
    address: pool,
    abi: MOCK_POOL_ABI,
    functionName: "getReservesList",
  });
  return mapLimit(list, CONCURRENCY, async (asset) => {
    const [meta, r] = await Promise.all([
      tokenMeta(asset),
      publicClient.readContract({
        address: pool,
        abi: MOCK_POOL_ABI,
        functionName: "reserves",
        args: [asset],
      }),
    ]);
    const [, price, ltBps, ltvBps, vToken] = r;
    return {
      symbol: meta.symbol,
      address: asset.toLowerCase() as Address,
      decimals: meta.decimals,
      aToken: pool, // MockPool holds supplies itself; getReserveData reports the pool as aToken
      vToken,
      priceUsd: baseToUsd(price),
      isStable: STABLE_SYMBOLS.has(meta.symbol.toUpperCase()),
      liquidationThresholdBps: Number(ltBps),
      ltvBps: Number(ltvBps),
    } satisfies ReserveInfo;
  });
}

/** Reserve list with live prices (cached 20s). Empty when the pool is not configured on testnet. */
export async function listReserves(opts: { fresh?: boolean } = {}): Promise<ReserveInfo[]> {
  if (!opts.fresh && reservesCache && Date.now() - reservesCache.at < RESERVES_TTL_MS)
    return reservesCache.value;
  if (!config.poolAddress) {
    return config.chain === "mainnet"
      ? MAINNET_RESERVES.map((r) => ({
          symbol: r.symbol,
          address: r.address.toLowerCase() as Address,
          decimals: r.decimals,
          aToken: r.aToken,
          vToken: r.vToken,
          priceUsd: 0,
          isStable: r.stable,
        }))
      : [];
  }
  const value = config.chain === "mainnet" ? await mainnetReserves() : await testnetReserves();
  reservesCache = { at: Date.now(), value };
  return value;
}

/** Static reserve metadata without touching the RPC (mainnet only; testnet needs the pool). */
export function staticReserves(): ReserveInfo[] {
  if (config.chain !== "mainnet") return reservesCache?.value ?? [];
  return MAINNET_RESERVES.map((r) => ({
    symbol: r.symbol,
    address: r.address.toLowerCase() as Address,
    decimals: r.decimals,
    aToken: r.aToken,
    vToken: r.vToken,
    priceUsd: 0,
    isStable: r.stable,
  }));
}

// ------------------------------------------------------------------ position
async function accountData(user: Address) {
  const pool = poolAddress();
  const abi = config.chain === "mainnet" ? AAVE_POOL_ABI : MOCK_POOL_ABI;
  const [collateralBase, debtBase, , ltBps, ltvBps, hf] = await publicClient.readContract({
    address: pool,
    abi,
    functionName: "getUserAccountData",
    args: [user],
  });
  return { collateralBase, debtBase, ltBps: Number(ltBps), ltvBps: Number(ltvBps), hf };
}

async function balancesFor(user: Address, reserves: ReserveInfo[]): Promise<ReservePosition[]> {
  const pool = poolAddress();
  return mapLimit(reserves, CONCURRENCY, async (r) => {
    const [suppliedRaw, borrowedRaw] = await Promise.all([
      config.chain === "mainnet"
        ? publicClient.readContract({
            address: r.aToken,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [user],
          })
        : publicClient.readContract({
            address: pool,
            abi: MOCK_POOL_ABI,
            functionName: "supplied",
            args: [user, r.address],
          }),
      publicClient.readContract({
        address: r.vToken,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [user],
      }),
    ]);
    const price8 = BigInt(Math.round(r.priceUsd * 1e8));
    return {
      ...r,
      supplied: formatUnitsStr(suppliedRaw, r.decimals),
      borrowed: formatUnitsStr(borrowedRaw, r.decimals),
      suppliedRaw,
      borrowedRaw,
      suppliedUsd: tokenUsd(suppliedRaw, r.decimals, price8),
      borrowedUsd: tokenUsd(borrowedRaw, r.decimals, price8),
    };
  });
}

/**
 * Aave (mainnet) or MockPool (testnet) account view for `address`:
 * account totals + per-reserve balances + prices + liquidation price hints.
 */
export async function readPosition(address: Address): Promise<Position> {
  const user = getAddress(address);
  const [acct, reserves] = await Promise.all([accountData(user), listReserves({ fresh: true })]);
  const legs = await balancesFor(user, reserves);
  const collateralUsd = baseToUsd(acct.collateralBase);
  const debtUsd = baseToUsd(acct.debtBase);
  const hints = liquidationPrices(
    legs.map((l) => ({
      symbol: l.symbol,
      suppliedUsd: l.suppliedUsd,
      priceUsd: l.priceUsd,
      liquidationThresholdBps: l.liquidationThresholdBps,
    })),
    debtUsd,
    acct.ltBps,
  );
  return {
    address: user.toLowerCase() as Address,
    chain: config.chain,
    collateralUsd,
    debtUsd,
    hf: hfToNumber(acct.hf),
    hfRaw: acct.hf,
    liquidationThresholdBps: acct.ltBps,
    ltvBps: acct.ltvBps,
    reserves: legs,
    liquidationPriceHints: hints,
    fetchedAt: Date.now(),
  };
}

/** User's wallet balance of `asset` and allowance granted to the guard (the repayment buffer). */
export async function readBuffer(user: Address, asset: Address, spender: Address) {
  const [balance, allowance] = await Promise.all([
    publicClient.readContract({ address: asset, abi: ERC20_ABI, functionName: "balanceOf", args: [user] }),
    publicClient.readContract({
      address: asset,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [user, spender],
    }),
  ]);
  return { balance, allowance };
}

/** JSON-safe view of a position (bigints removed, hf Infinity → null). */
export function positionToJson(p: Position) {
  return {
    address: p.address,
    chain: p.chain,
    healthFactor: Number.isFinite(p.hf) ? Math.round(p.hf * 1e4) / 1e4 : null,
    hf: Number.isFinite(p.hf) ? Math.round(p.hf * 1e4) / 1e4 : null,
    totalCollateralUsd: p.collateralUsd,
    collateralUsd: p.collateralUsd,
    totalDebtUsd: p.debtUsd,
    debtUsd: p.debtUsd,
    liquidationThresholdBps: p.liquidationThresholdBps,
    ltvBps: p.ltvBps,
    reserves: p.reserves.map((r) => ({
      symbol: r.symbol,
      address: r.address,
      decimals: r.decimals,
      aToken: r.aToken,
      vToken: r.vToken,
      price: r.priceUsd,
      priceUsd: r.priceUsd,
      isStable: r.isStable,
      supplied: r.supplied,
      borrowed: r.borrowed,
      suppliedUsd: r.suppliedUsd,
      borrowedUsd: r.borrowedUsd,
      liquidationThresholdBps: r.liquidationThresholdBps ?? null,
    })),
    liquidationPriceHints: p.liquidationPriceHints,
    fetchedAt: p.fetchedAt,
  };
}

export type PositionJson = ReturnType<typeof positionToJson>;
