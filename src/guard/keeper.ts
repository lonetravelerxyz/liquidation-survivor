import { getAddress, parseEventLogs, type Address, type Hex } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { SURVIVAL_GUARD_ABI } from "./abi.js";
import { getKeeperAccount, getKeeperWallet, publicClient } from "./client.js";

export interface ProtectedEventArgs {
  user: Address;
  debtAsset: Address;
  repaid: bigint;
  fee: bigint;
  hfBefore: bigint;
  hfAfter: bigint;
  keeper: Address;
}

export interface ProtectResult {
  txHash: Hex;
  repaid: bigint;
  gasUsed: bigint;
  blockNumber: bigint;
  /** Decoded Protected event from the receipt (null if the node returned no logs). */
  event: ProtectedEventArgs | null;
}

const log = logger.child({ module: "keeper" });

/**
 * Call `SurvivalGuard.protect(user)` with the keeper key: simulate → write → wait for the receipt.
 * The contract re-checks every rule on-chain; this function never touches user keys or funds.
 * Throws with the decoded revert reason when the simulation fails.
 */
export async function protect(user: Address): Promise<ProtectResult> {
  const wallet = getKeeperWallet();
  const account = getKeeperAccount();
  if (!wallet || !account) throw new Error("keeper not configured (KEEPER_PRIVATE_KEY)");
  if (!config.guardAddress) throw new Error("guard address not configured");

  const target = getAddress(user);
  const { request, result } = await publicClient.simulateContract({
    account,
    address: config.guardAddress,
    abi: SURVIVAL_GUARD_ABI,
    functionName: "protect",
    args: [target],
  });
  const txHash = await wallet.writeContract(request);
  log.info({ user: target, txHash, expectedRepaid: result.toString() }, "protect sent");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") {
    log.error({ user: target, txHash }, "protect reverted on-chain");
    throw new Error(`protect reverted: ${txHash}`);
  }
  log.info(
    { user: target, txHash, gasUsed: receipt.gasUsed.toString(), block: receipt.blockNumber.toString() },
    "protect mined",
  );
  const events = parseEventLogs({
    abi: SURVIVAL_GUARD_ABI,
    eventName: "Protected",
    logs: receipt.logs,
    strict: true,
  });
  const ev = events[0]?.args ?? null;
  return {
    txHash,
    repaid: ev?.repaid ?? result,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
    event: ev,
  };
}

export const keeperAddress = (): Address | null => getKeeperAccount()?.address ?? null;
