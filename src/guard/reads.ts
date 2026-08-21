import { getAddress, type Address } from "viem";
import { config } from "../config.js";
import { publicClient } from "./client.js";
import { SURVIVAL_GUARD_ABI } from "./abi.js";

export interface Plan {
  debtAsset: Address;
  triggerHF: bigint; // 1e18
  targetHF: bigint; // 1e18
  maxRepayPerProtect: bigint; // debtAsset units
  cooldown: number;
  active: boolean;
}

export interface Preview {
  eligible: boolean;
  reason: string;
  hf: bigint;
  repayAmount: bigint;
}

export interface GuardInfo {
  address: Address;
  feeBps: number;
  paused: boolean;
  pool: Address;
  oracle: Address;
}

const ZERO = "0x0000000000000000000000000000000000000000";

const guardAddress = (): Address => {
  if (!config.guardAddress) throw new Error("guard address not configured");
  return config.guardAddress;
};

export const isGuardConfigured = (): boolean => Boolean(config.guardAddress);

/** Plan for `user`; null when the user never enrolled (debtAsset == 0). */
export async function getPlan(user: Address): Promise<Plan | null> {
  const p = await publicClient.readContract({
    address: guardAddress(),
    abi: SURVIVAL_GUARD_ABI,
    functionName: "plans",
    args: [getAddress(user)],
  });
  if (p.debtAsset.toLowerCase() === ZERO) return null;
  return {
    debtAsset: p.debtAsset,
    triggerHF: p.triggerHF,
    targetHF: p.targetHF,
    maxRepayPerProtect: p.maxRepayPerProtect,
    cooldown: Number(p.cooldown),
    active: p.active,
  };
}

export async function previewProtect(user: Address): Promise<Preview> {
  const [eligible, reason, hf, repayAmount] = await publicClient.readContract({
    address: guardAddress(),
    abi: SURVIVAL_GUARD_ABI,
    functionName: "previewProtect",
    args: [getAddress(user)],
  });
  return { eligible, reason, hf, repayAmount };
}

export async function getLastProtectAt(user: Address): Promise<number> {
  const t = await publicClient.readContract({
    address: guardAddress(),
    abi: SURVIVAL_GUARD_ABI,
    functionName: "lastProtectAt",
    args: [getAddress(user)],
  });
  return Number(t);
}

let infoCache: { at: number; value: GuardInfo } | null = null;

/** feeBps / paused / POOL / ORACLE — cached for 30s (pool + oracle are immutable, fee and paused rarely change). */
export async function guardInfo(): Promise<GuardInfo> {
  if (infoCache && Date.now() - infoCache.at < 30_000) return infoCache.value;
  const address = guardAddress();
  const [feeBps, paused, pool, oracle] = await Promise.all([
    publicClient.readContract({ address, abi: SURVIVAL_GUARD_ABI, functionName: "feeBps" }),
    publicClient.readContract({ address, abi: SURVIVAL_GUARD_ABI, functionName: "paused" }),
    publicClient.readContract({ address, abi: SURVIVAL_GUARD_ABI, functionName: "POOL" }),
    publicClient.readContract({ address, abi: SURVIVAL_GUARD_ABI, functionName: "ORACLE" }),
  ]);
  const value: GuardInfo = { address, feeBps: Number(feeBps), paused, pool, oracle };
  infoCache = { at: Date.now(), value };
  return value;
}

export const planToJson = (p: Plan | null) =>
  p
    ? {
        debtAsset: p.debtAsset.toLowerCase(),
        triggerHF: p.triggerHF.toString(),
        targetHF: p.targetHF.toString(),
        maxRepayPerProtect: p.maxRepayPerProtect.toString(),
        cooldown: p.cooldown,
        active: p.active,
        triggerHf: Number(p.triggerHF) / 1e18,
        targetHf: Number(p.targetHF) / 1e18,
      }
    : null;
