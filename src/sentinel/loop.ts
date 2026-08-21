import type { Address } from "viem";
import { listReserves, readPosition } from "../aave/position.js";
import { formatUnitsStr, hfToNumber } from "../aave/math.js";
import { digestEvent } from "../ai/explain.js";
import { config, keeperEnabled, poolConfigured } from "../config.js";
import { explorerTx } from "../chains/xlayer.js";
import { notifications, plans, protections, snapshots, type PlanRow } from "../db/queries.js";
import { protect } from "../guard/keeper.js";
import { guardInfo, previewProtect } from "../guard/reads.js";
import { logger } from "../logger.js";
import { sendToAddress } from "../telegram/notify.js";
import { templates } from "../telegram/templates.js";
import { failedDedupeKey, protectedDedupeKey, shouldProtect, shouldWarn, warnDedupeKey } from "./decision.js";
import { indexGuardEvents, type IndexedProtection } from "./indexer.js";

const log = logger.child({ module: "sentinel" });
const nowS = () => Math.floor(Date.now() / 1000);

let running = false;
let pending = false;
let timer: NodeJS.Timeout | null = null;
let idleLogged = 0;
let lastTickAt = 0;
let tickCount = 0;

export const sentinelStatus = () => ({ running, lastTickAt, tickCount, enabled: config.sentinelEnabled });

async function symbolFor(asset: string): Promise<{ symbol: string; decimals: number }> {
  try {
    const r = (await listReserves()).find((x) => x.address.toLowerCase() === asset.toLowerCase());
    if (r) return { symbol: r.symbol, decimals: r.decimals };
  } catch {
    /* fall through */
  }
  return { symbol: asset.slice(0, 8), decimals: 18 };
}

/** Telegram "protected" push with an AI (or rules) digest. Deduped per tx hash. */
export async function notifyProtected(p: IndexedProtection): Promise<void> {
  const key = protectedDedupeKey(p.txHash);
  if (!notifications.claim(p.address, "protected", key, { txHash: p.txHash })) return;
  const meta = await symbolFor(p.debtAsset);
  const repaid = formatUnitsStr(p.repaid, meta.decimals);
  const fee = formatUnitsStr(p.fee, meta.decimals);
  const hfBefore = hfToNumber(p.hfBefore);
  const hfAfter = hfToNumber(p.hfAfter);
  const digest = await digestEvent({
    kind: "protected",
    address: p.address,
    debtAssetSymbol: meta.symbol,
    repaid,
    fee,
    hfBefore,
    hfAfter,
    txUrl: explorerTx(config.chainId, p.txHash),
  });
  const sent = await sendToAddress(
    p.address,
    templates.protected({
      address: p.address,
      txHash: p.txHash,
      repaid,
      symbol: meta.symbol,
      hfBefore,
      hfAfter,
      digest: digest.text,
    }),
  );
  if (sent > 0) notifications.markSent(key);
  log.info({ address: p.address, txHash: p.txHash, sent }, "protected notification");
}

async function notifyWarning(address: string, hf: number, triggerHf: number): Promise<void> {
  const key = warnDedupeKey(address, nowS());
  if (!notifications.claim(address, "warning", key, { hf, triggerHf })) return;
  const digest = await digestEvent({ kind: "warning", address, hf, triggerHf });
  const sent = await sendToAddress(
    address,
    templates.warning({ address, hf, triggerHf, digest: digest.text }),
  );
  if (sent > 0) notifications.markSent(key);
  log.info({ address, hf, triggerHf, sent }, "warning notification");
}

async function notifyFailed(address: string, reason: string): Promise<void> {
  const key = failedDedupeKey(address, nowS());
  if (!notifications.claim(address, "failed", key, { reason })) return;
  const sent = await sendToAddress(address, templates.failed({ address, reason }));
  if (sent > 0) notifications.markSent(key);
}

/** One enrolled address: read → snapshot → warn → protect. Errors are logged, never thrown. */
export async function checkPlan(row: PlanRow, paused: boolean): Promise<void> {
  const address = row.address as Address;
  try {
    const [position, preview] = await Promise.all([readPosition(address), previewProtect(address)]);
    const hf = position.hf;
    snapshots.insert(
      address,
      Number.isFinite(hf) ? hf.toFixed(6) : "inf",
      position.collateralUsd,
      position.debtUsd,
    );
    const triggerHf = Number(BigInt(row.trigger_hf)) / 1e18;
    log.debug({ address, hf, triggerHf, eligible: preview.eligible, reason: preview.reason }, "checked");

    if (shouldWarn({ hf, triggerHf, active: row.active === 1 })) await notifyWarning(address, hf, triggerHf);

    if (
      shouldProtect({
        eligible: preview.eligible,
        keeperEnabled: keeperEnabled(),
        paused,
        repayAmount: preview.repayAmount,
      })
    ) {
      log.info({ address, hf, repayAmount: preview.repayAmount.toString() }, "eligible → protect");
      try {
        const res = await protect(address);
        if (res.event) {
          const rec: IndexedProtection = {
            txHash: res.txHash,
            address: res.event.user,
            debtAsset: res.event.debtAsset,
            repaid: res.event.repaid,
            fee: res.event.fee,
            hfBefore: res.event.hfBefore,
            hfAfter: res.event.hfAfter,
            keeper: res.event.keeper,
            block: res.blockNumber,
            ts: nowS(),
          };
          protections.insert({
            tx_hash: rec.txHash,
            address: rec.address,
            debt_asset: rec.debtAsset,
            repaid: rec.repaid.toString(),
            fee: rec.fee.toString(),
            hf_before: rec.hfBefore.toString(),
            hf_after: rec.hfAfter.toString(),
            keeper: rec.keeper,
            block: Number(rec.block),
            ts: rec.ts,
          });
          await notifyProtected(rec);
        }
      } catch (err) {
        const reason = (err as Error).message.split("\n")[0] ?? "unknown";
        log.warn({ address, reason }, "protect failed");
        await notifyFailed(address, reason.slice(0, 160));
      }
    } else if (preview.eligible && !keeperEnabled()) {
      log.warn({ address }, "eligible but keeper is not configured (KEEPER_PRIVATE_KEY)");
    }
  } catch (err) {
    log.warn({ address, err: (err as Error).message }, "check failed");
  }
}

/** One full pass: index events → check every active plan. Overlapping calls coalesce into one extra run. */
export async function tick(): Promise<void> {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  lastTickAt = Date.now();
  tickCount++;
  try {
    if (!config.guardAddress || !poolConfigured()) {
      if (idleLogged++ % 10 === 0) log.info("guard address not configured; sentinel idle");
      return;
    }
    const { newProtections } = await indexGuardEvents();
    for (const p of newProtections)
      await notifyProtected(p).catch((err) => log.warn({ err }, "notify failed"));

    let paused = false;
    try {
      paused = (await guardInfo()).paused;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "guardInfo failed; assuming not paused");
    }
    const active = plans.active();
    for (const row of active) await checkPlan(row, paused);
    if (tickCount % 60 === 0) snapshots.pruneOlderThan(nowS() - 7 * 86_400);
    log.debug({ plans: active.length, newProtections: newProtections.length }, "tick done");
  } catch (err) {
    log.error({ err: (err as Error).message }, "tick failed");
  } finally {
    running = false;
    if (pending) {
      pending = false;
      setTimeout(() => void tick(), 250);
    }
  }
}

/** Ask for an immediate pass (webhook / manual). Returns immediately. */
export const requestTick = (): void => {
  void tick();
};

export function startSentinel(): { stop: () => void } {
  if (!config.sentinelEnabled) {
    log.info("sentinel disabled (SENTINEL_ENABLED=false)");
    return { stop: () => undefined };
  }
  log.info(
    { intervalMs: config.sentinelIntervalMs, keeper: keeperEnabled(), chain: config.chain },
    "sentinel started",
  );
  void tick();
  timer = setInterval(() => void tick(), Math.max(5_000, config.sentinelIntervalMs));
  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
