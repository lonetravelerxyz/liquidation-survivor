// Deterministic, dependency-free fallback for every AI task. Pure functions → unit-testable.
import type { PositionJson } from "../aave/position.js";
import { formatUnitsStr, repayUsdToReach, round } from "../aave/math.js";
import type { Digest, Explain, Recommend } from "./prompts.js";

export interface PlanLike {
  debtAsset: string;
  triggerHf: number;
  targetHf: number;
  maxRepayPerProtect: string;
  cooldown: number;
  active: boolean;
}

export const DEFAULTS = {
  triggerHF: 1.15,
  targetHF: 1.4,
  cooldown: 600,
  maxRepayShareOfDebt: 0.3,
  penaltyMin: 0.05,
  penaltyMax: 0.1,
} as const;

export function riskLevel(hf: number | null): Explain["riskLevel"] {
  if (hf === null || hf >= 1.5) return "safe";
  if (hf >= 1.15) return "watch";
  return "danger";
}

const fmtUsd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const fmtHf = (hf: number | null) => (hf === null ? "∞ (no debt)" : hf.toFixed(2));

export function rulesExplain(position: PositionJson, plan?: PlanLike | null): Explain {
  const hf = position.hf;
  const level = riskLevel(hf);
  const debt = position.debtUsd;
  const liquidationPrices = position.liquidationPriceHints.map((h) => ({
    symbol: h.symbol,
    price: h.liquidationPrice,
    dropPct: h.dropPct,
  }));
  const bullets: string[] = [];
  const closest = liquidationPrices
    .filter((l) => l.dropPct !== null)
    .sort((a, b) => (a.dropPct ?? 1e9) - (b.dropPct ?? 1e9))[0];

  let summary: string;
  if (debt <= 0) {
    summary = `You have ${fmtUsd(position.collateralUsd)} supplied and no debt, so there is nothing to liquidate. Enrolling now only arms the guard for later.`;
  } else {
    summary = `Health factor ${fmtHf(hf)}: ${fmtUsd(position.collateralUsd)} of collateral backs ${fmtUsd(debt)} of debt.`;
    if (closest?.price != null && closest.dropPct != null) {
      summary += ` If ${closest.symbol} falls roughly ${closest.dropPct.toFixed(1)}% to about ${fmtUsd(closest.price)}, the position may be liquidated.`;
    }
    summary +=
      level === "danger"
        ? " This is close to the line; repaying or adding collateral soon reduces the risk."
        : level === "watch"
          ? " There is some room, but a sharp move could still reach the trigger."
          : " There is a comfortable margin today.";
    bullets.push(
      `A liquidation on Aave X Layer may cost roughly ${fmtUsd(debt * DEFAULTS.penaltyMin)}–${fmtUsd(debt * DEFAULTS.penaltyMax)} (5–10% bonus on seized collateral).`,
    );
  }
  if (plan) {
    bullets.push(
      plan.active
        ? `Your guard plan is active: it repays up to ${plan.maxRepayPerProtect} of the debt asset when HF drops below ${plan.triggerHf.toFixed(2)}, aiming for ${plan.targetHf.toFixed(2)}.`
        : "You have a guard plan but it is disabled; re-enable it to get protection.",
    );
  } else {
    bullets.push(
      "No guard plan yet. Enrolling pre-authorises a bounded repayment from your stablecoin buffer.",
    );
  }
  bullets.push("Numbers come from the on-chain pool and oracle; they move with prices and accrued interest.");

  return {
    summary,
    riskLevel: level,
    liquidationPrices,
    estimatedPenaltyUsd:
      debt > 0
        ? { min: round(debt * DEFAULTS.penaltyMin, 2), max: round(debt * DEFAULTS.penaltyMax, 2) }
        : null,
    bullets: bullets.slice(0, 6),
  };
}

/** Pick the reserve to repay: the borrowed stablecoin with the largest debt, else the largest debt. */
export function pickDebtAsset(position: PositionJson) {
  const borrowed = position.reserves.filter((r) => r.borrowedUsd > 0);
  if (borrowed.length === 0) return null;
  const stable = borrowed.filter((r) => r.isStable).sort((a, b) => b.borrowedUsd - a.borrowedUsd)[0];
  return stable ?? borrowed.sort((a, b) => b.borrowedUsd - a.borrowedUsd)[0] ?? null;
}

export function rulesRecommend(position: PositionJson, opts: { bufferUsd?: number } = {}): Recommend {
  const debtUsd = position.debtUsd;
  const asset = pickDebtAsset(position);
  const triggerHF = DEFAULTS.triggerHF;
  const targetHF = DEFAULTS.targetHF;
  // Repay needed to move from hf = trigger to hf = target with today's collateral (see docs/contracts.md math).
  const lt = position.liquidationThresholdBps;
  const debtAtTrigger = (position.collateralUsd * lt) / 10_000 / triggerHF;
  const repayAtTrigger = repayUsdToReach(position.collateralUsd, debtAtTrigger, lt, targetHF);
  const suggestedBuffer = round(Math.max(repayAtTrigger * 1.2, 0), 2);
  const cap = debtUsd * DEFAULTS.maxRepayShareOfDebt;
  const bufferUsd =
    opts.bufferUsd !== undefined && opts.bufferUsd > 0
      ? Math.min(opts.bufferUsd, Math.max(cap, suggestedBuffer))
      : suggestedBuffer;
  const maxRepayUsd = round(debtUsd > 0 ? Math.min(cap, Math.max(bufferUsd, 0)) : 0, 2);
  let maxRepayPerProtect = "0";
  if (asset && asset.priceUsd > 0 && maxRepayUsd > 0) {
    const units =
      BigInt(Math.floor((maxRepayUsd / asset.priceUsd) * 10 ** Math.min(asset.decimals, 8))) *
      10n ** BigInt(Math.max(asset.decimals - 8, 0));
    maxRepayPerProtect = formatUnitsStr(units, asset.decimals);
  }
  const rationale: string[] = [];
  if (debtUsd <= 0) {
    rationale.push("No debt today, so the defaults below simply arm the guard for when you borrow.");
  } else {
    rationale.push(
      `Trigger ${triggerHF.toFixed(2)} leaves a cushion above 1.0 so the guard acts before a liquidator can; target ${targetHF.toFixed(2)} restores a comfortable margin.`,
    );
    rationale.push(
      `Each protect repays at most ${fmtUsd(maxRepayUsd)} (about ${Math.round(DEFAULTS.maxRepayShareOfDebt * 100)}% of debt, capped by your buffer); keeping roughly ${fmtUsd(bufferUsd)} of ${asset?.symbol ?? "stablecoin"} approved covers one dip from the trigger back to target.`,
    );
  }
  rationale.push(
    `Cooldown ${DEFAULTS.cooldown}s stops repeated repays in a single volatile minute. The contract re-checks every rule on-chain.`,
  );
  return {
    debtAsset: asset?.address ?? null,
    debtAssetSymbol: asset?.symbol ?? null,
    triggerHF,
    targetHF,
    maxRepayPerProtect,
    maxRepayUsd,
    bufferUsd: round(bufferUsd, 2),
    cooldown: DEFAULTS.cooldown,
    rationale,
  };
}

export interface ProtectedEventLike {
  kind: "protected";
  address: string;
  debtAssetSymbol: string;
  repaid: string; // token units
  fee: string;
  hfBefore: number;
  hfAfter: number;
  txUrl: string;
}
export interface WarningEventLike {
  kind: "warning";
  address: string;
  hf: number;
  triggerHf: number;
}
export type EventLike = ProtectedEventLike | WarningEventLike;

export function rulesDigest(e: EventLike): Digest {
  if (e.kind === "protected") {
    return {
      text: `Your guard repaid ${e.repaid} ${e.debtAssetSymbol} of your Aave debt (keeper fee ${e.fee}). Health factor moved from ${e.hfBefore.toFixed(2)} to ${e.hfAfter.toFixed(2)}.`,
    };
  }
  return {
    text: `Health factor ${e.hf.toFixed(2)} is close to your trigger ${e.triggerHf.toFixed(2)}. The guard will repay from your buffer if it crosses; topping up collateral or the buffer adds room.`,
  };
}
