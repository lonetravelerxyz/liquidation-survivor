// Pure helpers for health-factor maths. No I/O so they are unit-testable.
// Aave: hf = Σ(collateral_i × LT_i) / Σ(debt_j), base currency USD with 8 decimals, hf scaled 1e18.

export const WAD = 10n ** 18n;
export const BASE_UNIT = 10n ** 8n; // Aave oracle base currency on X Layer: USD, 8 decimals
export const MAX_UINT256 = (1n << 256n) - 1n;

/** 1e18-scaled health factor → number; Infinity when the account has no debt (Aave returns max uint). */
export function hfToNumber(hf: bigint): number {
  if (hf >= MAX_UINT256 / 2n) return Infinity;
  return Number(hf) / 1e18;
}

/** For JSON: Infinity → null, otherwise round to 4 decimals. */
export function hfForJson(hf: number): number | null {
  if (!Number.isFinite(hf)) return null;
  return Math.round(hf * 1e4) / 1e4;
}

/** Base-currency (1e8) → USD number. */
export const baseToUsd = (v: bigint): number => Number(v) / 1e8;

/** Token amount (bigint, `decimals`) → decimal string, trimmed. */
export function formatUnitsStr(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const s = a.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

/** Decimal string → bigint in `decimals` (truncates extra precision). */
export function parseUnitsStr(value: string, decimals: number): bigint {
  const [int = "0", frac = ""] = value.trim().split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const neg = int.startsWith("-");
  const digits = (neg ? int.slice(1) : int) + fracPadded;
  const v = BigInt(digits.replace(/^0+(?=\d)/, "") || "0");
  return neg ? -v : v;
}

/** USD value of `amount` tokens priced at `price` (8-dec base). */
export function tokenUsd(amount: bigint, decimals: number, price8: bigint): number {
  if (amount === 0n) return 0;
  // amount * price / 10^decimals / 1e8 — keep bigint precision until the final division
  const scaled = (amount * price8) / 10n ** BigInt(decimals);
  return Number(scaled) / 1e8;
}

export interface CollateralLeg {
  symbol: string;
  suppliedUsd: number;
  priceUsd: number;
  /** per-asset liquidation threshold in bps; falls back to the account-level average when unknown */
  liquidationThresholdBps?: number;
}

export interface LiquidationPriceHint {
  symbol: string;
  currentPrice: number;
  /** price at which hf crosses 1 if only this asset moves; null when other collateral alone covers the debt */
  liquidationPrice: number | null;
  /** % drop from current price to liquidation; null when liquidationPrice is null */
  dropPct: number | null;
}

/**
 * Liquidation price per collateral asset, assuming only that asset's price moves.
 * hf(p) = (Σ_{i≠k} c_i·LT_i + c_k·(p/p_k)·LT_k) / debt = 1  ⇒  p = p_k · (debt − Σ_{i≠k} c_i·LT_i) / (c_k·LT_k)
 */
export function liquidationPrices(
  legs: readonly CollateralLeg[],
  debtUsd: number,
  accountLtBps: number,
): LiquidationPriceHint[] {
  const out: LiquidationPriceHint[] = [];
  if (debtUsd <= 0) {
    return legs
      .filter((l) => l.suppliedUsd > 0)
      .map((l) => ({ symbol: l.symbol, currentPrice: l.priceUsd, liquidationPrice: null, dropPct: null }));
  }
  const weighted = legs.map((l) => l.suppliedUsd * ((l.liquidationThresholdBps ?? accountLtBps) / 10_000));
  const total = weighted.reduce((a, b) => a + b, 0);
  legs.forEach((l, k) => {
    if (l.suppliedUsd <= 0 || l.priceUsd <= 0) return;
    const others = total - (weighted[k] ?? 0);
    const ltK = (l.liquidationThresholdBps ?? accountLtBps) / 10_000;
    const numerator = debtUsd - others;
    if (numerator <= 0 || ltK <= 0) {
      out.push({ symbol: l.symbol, currentPrice: l.priceUsd, liquidationPrice: null, dropPct: null });
      return;
    }
    const p = l.priceUsd * (numerator / (l.suppliedUsd * ltK));
    const dropPct = Math.max(0, (1 - p / l.priceUsd) * 100);
    out.push({
      symbol: l.symbol,
      currentPrice: l.priceUsd,
      liquidationPrice: round(p, 6),
      dropPct: round(dropPct, 2),
    });
  });
  return out;
}

/** Debt (USD) that must be repaid so hf reaches `targetHf` — mirrors SurvivalGuard._wantedRepay. */
export function repayUsdToReach(
  collateralUsd: number,
  debtUsd: number,
  ltBps: number,
  targetHf: number,
): number {
  if (debtUsd <= 0 || targetHf <= 0) return 0;
  const debtTarget = (collateralUsd * ltBps) / 10_000 / targetHf;
  return Math.max(0, debtUsd - debtTarget);
}

/** HF after repaying `repayUsd` of debt (same collateral). */
export function hfAfterRepay(
  collateralUsd: number,
  debtUsd: number,
  ltBps: number,
  repayUsd: number,
): number {
  const d = debtUsd - repayUsd;
  if (d <= 0) return Infinity;
  return (collateralUsd * ltBps) / 10_000 / d;
}

export const round = (v: number, digits: number): number => {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
};
