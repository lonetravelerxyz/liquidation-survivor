// Pure decision helpers for the sentinel loop. No I/O → unit-tested in tests/decision.test.ts.

/** Warn when hf is within this factor above the trigger (1.1 = within 10%). */
export const WARN_FACTOR = 1.1;
/** One warning per address per window. */
export const WARN_WINDOW_S = 30 * 60;
/** One "protect failed" note per address per window. */
export const FAILED_WINDOW_S = 30 * 60;

export interface WarnInput {
  /** current health factor (Infinity when no debt) */
  hf: number;
  /** plan trigger as a number, e.g. 1.15 */
  triggerHf: number;
  active: boolean;
}

/** True when the user should be told the position is close to (or below) the trigger. */
export function shouldWarn(i: WarnInput): boolean {
  if (!i.active) return false;
  if (!Number.isFinite(i.hf) || i.hf <= 0) return false;
  if (i.triggerHf <= 0) return false;
  return i.hf < i.triggerHf * WARN_FACTOR;
}

export interface ProtectInput {
  eligible: boolean;
  keeperEnabled: boolean;
  paused: boolean;
  /** repay amount the contract would pull (0 → nothing to do) */
  repayAmount: bigint;
}

/** True when the keeper should send `protect` now. The contract re-checks everything on-chain anyway. */
export function shouldProtect(i: ProtectInput): boolean {
  return i.eligible && i.keeperEnabled && !i.paused && i.repayAmount > 0n;
}

/** Dedupe key for warnings: one per address per WARN_WINDOW_S bucket. */
export const warnDedupeKey = (address: string, nowS: number): string =>
  `warning:${address.toLowerCase()}:${Math.floor(nowS / WARN_WINDOW_S)}`;

export const failedDedupeKey = (address: string, nowS: number): string =>
  `failed:${address.toLowerCase()}:${Math.floor(nowS / FAILED_WINDOW_S)}`;

/** One notification per Protected event (tx hash is unique per protect). */
export const protectedDedupeKey = (txHash: string): string => `protected:${txHash.toLowerCase()}`;

/** Smaller chunk after an RPC range error; never below `min`. */
export const shrinkChunk = (chunk: number, min = 100): number => Math.max(min, Math.floor(chunk / 2));
