import { type Address, type Hex } from "viem";
import { config } from "../config.js";
import { plans, protections, state } from "../db/queries.js";
import { SURVIVAL_GUARD_ABI } from "../guard/abi.js";
import { publicClient } from "../guard/client.js";
import { logger } from "../logger.js";
import { shrinkChunk } from "./decision.js";

const log = logger.child({ module: "indexer" });
export const STATE_KEY_BLOCK = "indexed_block";
/** Largest getLogs range the RPC accepted last time (X Layer testnet caps at 100 blocks; mainnet is larger). */
export const STATE_KEY_CHUNK = "indexer_chunk";
const MAX_CHUNKS_PER_RUN = 300;

const GUARD_EVENTS = SURVIVAL_GUARD_ABI.filter(
  (i) => i.type === "event" && ["Enrolled", "Updated", "Disabled", "Protected"].includes(i.name),
);

export interface IndexedProtection {
  txHash: Hex;
  address: string;
  debtAsset: string;
  repaid: bigint;
  fee: bigint;
  hfBefore: bigint;
  hfAfter: bigint;
  keeper: string;
  block: bigint;
  ts: number;
}

const blockTsCache = new Map<bigint, number>();
async function blockTimestamp(n: bigint): Promise<number> {
  const hit = blockTsCache.get(n);
  if (hit) return hit;
  const b = await publicClient.getBlock({ blockNumber: n });
  const ts = Number(b.timestamp);
  blockTsCache.set(n, ts);
  if (blockTsCache.size > 500) blockTsCache.delete(blockTsCache.keys().next().value as bigint);
  return ts;
}

/** Binary-search the first block where the guard has code (≈25 eth_getCode calls). */
export async function findDeploymentBlock(address: Address, head: bigint): Promise<bigint> {
  let lo = 0n;
  let hi = head;
  const hasCode = async (n: bigint) => {
    const code = await publicClient.getCode({ address, blockNumber: n });
    return Boolean(code && code !== "0x");
  };
  if (!(await hasCode(hi))) return hi; // not deployed yet (or RPC lag): start at head
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await hasCode(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

async function startBlock(head: bigint): Promise<bigint> {
  const saved = state.getInt(STATE_KEY_BLOCK);
  if (saved !== null) return BigInt(saved) + 1n;
  if (config.indexerStartBlock > 0) return BigInt(config.indexerStartBlock);
  const deployed = await findDeploymentBlock(config.guardAddress as Address, head);
  log.info({ deployed: deployed.toString() }, "guard deployment block found");
  return deployed;
}

type GuardLog = Awaited<ReturnType<typeof fetchLogs>>[number];
async function fetchLogs(address: Address, fromBlock: bigint, toBlock: bigint) {
  return publicClient.getLogs({ address, events: GUARD_EVENTS, fromBlock, toBlock, strict: true });
}

/** Applies one log to SQLite; returns a protection record when the log is a new Protected event. */
export async function applyLog(l: GuardLog): Promise<IndexedProtection | null> {
  const block = Number(l.blockNumber);
  switch (l.eventName) {
    case "Enrolled":
    case "Updated": {
      const p = l.args.plan;
      plans.upsert({
        address: l.args.user,
        debt_asset: p.debtAsset,
        trigger_hf: p.triggerHF.toString(),
        target_hf: p.targetHF.toString(),
        max_repay: p.maxRepayPerProtect.toString(),
        cooldown: Number(p.cooldown),
        active: p.active ? 1 : 0,
        updated_block: block,
      });
      return null;
    }
    case "Disabled":
      plans.setActive(l.args.user, false, block);
      return null;
    case "Protected": {
      const ts = await blockTimestamp(l.blockNumber);
      const rec: IndexedProtection = {
        txHash: l.transactionHash,
        address: l.args.user,
        debtAsset: l.args.debtAsset,
        repaid: l.args.repaid,
        fee: l.args.fee,
        hfBefore: l.args.hfBefore,
        hfAfter: l.args.hfAfter,
        keeper: l.args.keeper,
        block: l.blockNumber,
        ts,
      };
      const isNew = protections.insert({
        tx_hash: rec.txHash,
        address: rec.address,
        debt_asset: rec.debtAsset,
        repaid: rec.repaid.toString(),
        fee: rec.fee.toString(),
        hf_before: rec.hfBefore.toString(),
        hf_after: rec.hfAfter.toString(),
        keeper: rec.keeper,
        block,
        ts,
      });
      return isNew ? rec : null;
    }
    default:
      return null;
  }
}

/**
 * Poll guard events from the last indexed block to the head in ≤ chunk-size ranges; shrink the range when
 * the RPC rejects it. Returns newly inserted protections (for notifications). Never throws.
 */
export async function indexGuardEvents(): Promise<{
  newProtections: IndexedProtection[];
  indexedTo: bigint | null;
}> {
  const newProtections: IndexedProtection[] = [];
  if (!config.guardAddress) return { newProtections, indexedTo: null };
  const guard = config.guardAddress as Address;
  let indexedTo: bigint | null = null;
  try {
    const head = await publicClient.getBlockNumber();
    let from = await startBlock(head);
    const learned = state.getInt(STATE_KEY_CHUNK);
    let chunk = Math.max(100, Math.min(config.indexerChunkBlocks, learned ?? config.indexerChunkBlocks));
    let runs = 0;
    while (from <= head && runs < MAX_CHUNKS_PER_RUN) {
      const to = from + BigInt(chunk) - 1n > head ? head : from + BigInt(chunk) - 1n;
      let logs: GuardLog[];
      try {
        logs = await fetchLogs(guard, from, to);
      } catch (err) {
        if (chunk <= 100) throw err;
        const next = shrinkChunk(chunk);
        log.warn(
          { from: from.toString(), to: to.toString(), chunk, next, err: (err as Error).message },
          "getLogs failed; shrinking chunk",
        );
        chunk = next;
        state.set(STATE_KEY_CHUNK, chunk);
        continue;
      }
      logs.sort((a, b) =>
        a.blockNumber === b.blockNumber
          ? Number(a.logIndex - b.logIndex)
          : Number(a.blockNumber - b.blockNumber),
      );
      for (const l of logs) {
        const rec = await applyLog(l);
        if (rec) newProtections.push(rec);
      }
      state.set(STATE_KEY_BLOCK, to);
      indexedTo = to;
      if (logs.length)
        log.info({ from: from.toString(), to: to.toString(), logs: logs.length }, "indexed guard events");
      from = to + 1n;
      runs++;
    }
  } catch (err) {
    log.error({ err: (err as Error).message }, "indexer run failed");
  }
  return { newProtections, indexedTo };
}

export const lastIndexedBlock = (): number | null => state.getInt(STATE_KEY_BLOCK);
