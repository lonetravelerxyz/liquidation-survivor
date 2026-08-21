import { Router, type NextFunction, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { listReserves, positionToJson, readBuffer, readPosition, staticReserves } from "../aave/position.js";
import { formatUnitsStr, hfToNumber } from "../aave/math.js";
import { explainPosition, recommendPlan } from "../ai/explain.js";
import { aiEnabled, config, keeperEnabled, telegramEnabled } from "../config.js";
import { MAINNET_ORACLE } from "../chains/xlayer.js";
import { plans, protections, snapshots, telegram as tgq } from "../db/queries.js";
import { ERC20_ABI, SURVIVAL_GUARD_ABI } from "../guard/abi.js";
import {
  getLastProtectAt,
  getPlan,
  guardInfo,
  isGuardConfigured,
  planToJson,
  previewProtect,
} from "../guard/reads.js";
import { logger } from "../logger.js";
import { lastIndexedBlock } from "../sentinel/indexer.js";
import { sentinelStatus } from "../sentinel/loop.js";

export const apiRouter = Router();
const log = logger.child({ module: "api" });

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const AddressSchema = z
  .string()
  .refine((v) => isAddress(v), { message: "invalid address" })
  .transform((v) => getAddress(v) as Address);

const PlanInputSchema = z
  .object({
    debtAsset: AddressSchema.optional(),
    triggerHF: z.union([z.number(), z.string()]).optional(),
    targetHF: z.union([z.number(), z.string()]).optional(),
    maxRepayPerProtect: z.union([z.number(), z.string()]).optional(),
    cooldown: z.number().int().optional(),
    active: z.boolean().optional(),
  })
  .partial();

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const parseAddressParam = (raw: string): Address => {
  const r = AddressSchema.safeParse(raw);
  if (!r.success) throw new HttpError(400, "invalid address");
  return r.data;
};

const mask = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
async function reservesSafe() {
  try {
    return config.poolAddress ? await listReserves() : staticReserves();
  } catch {
    return staticReserves();
  }
}
const hfStr = (s: string | null | undefined): number | null => {
  if (!s || s === "inf") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------- GET /api/config
apiRouter.get(
  "/config",
  asyncRoute(async (_req, res) => {
    let reserves = staticReserves();
    let feeBps: number | null = null;
    let paused: boolean | null = null;
    let oracle: string | null = config.chain === "mainnet" ? MAINNET_ORACLE : config.poolAddress || null;
    if (config.poolAddress) {
      try {
        reserves = await listReserves();
      } catch (err) {
        log.warn({ err: (err as Error).message }, "config: reserves read failed");
      }
    }
    if (isGuardConfigured()) {
      try {
        const info = await guardInfo();
        feeBps = info.feeBps;
        paused = info.paused;
        oracle = info.oracle;
      } catch (err) {
        log.warn({ err: (err as Error).message }, "config: guard read failed");
      }
    }
    res.json({
      chain: config.chain,
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
      explorerBase: config.explorerBase,
      guard: config.guardAddress || null,
      guardAddress: config.guardAddress || null,
      pool: config.poolAddress || null,
      poolAddress: config.poolAddress || null,
      oracle,
      feeBps,
      paused,
      reserves: reserves.map((r) => ({
        symbol: r.symbol,
        address: r.address,
        decimals: r.decimals,
        aToken: r.aToken,
        vToken: r.vToken,
        priceUsd: r.priceUsd,
        isStable: r.isStable,
        stable: r.isStable,
      })),
      guardAbi: SURVIVAL_GUARD_ABI,
      erc20Abi: ERC20_ABI,
      telegramBotUsername: telegramEnabled() ? config.telegram.botUsername || null : null,
      telegramEnabled: telegramEnabled(),
      aiEnabled: aiEnabled(),
      keeperEnabled: keeperEnabled(),
      sentinel: sentinelStatus(),
    });
  }),
);

// ---------------------------------------------------------------- GET /api/prices
// Live market prices for the demo/volatile assets, proxied from OKX spot tickers
// (their API has no CORS headers, so browsers cannot fetch it directly). Cached
// briefly so a polling dashboard never hammers OKX.
const PRICE_INSTRUMENTS: { symbol: string; instId: string }[] = [
  { symbol: "xETH", instId: "ETH-USDT" },
  { symbol: "xBTC", instId: "BTC-USDT" },
  { symbol: "WOKB", instId: "OKB-USDT" },
];
type MarketPrice = { symbol: string; instId: string; priceUsd: number; changePct24h: number | null };
let priceCache: { at: number; prices: MarketPrice[] } | null = null;

async function fetchOkxTicker(instId: string): Promise<{ last: number; open24h: number | null } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { last?: string; open24h?: string }[] };
    const d = body.data?.[0];
    const last = Number(d?.last);
    if (!Number.isFinite(last) || last <= 0) return null;
    const open = Number(d?.open24h);
    return { last, open24h: Number.isFinite(open) && open > 0 ? open : null };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

apiRouter.get(
  "/prices",
  asyncRoute(async (_req, res) => {
    if (priceCache && Date.now() - priceCache.at < 5000) {
      res.json({ prices: priceCache.prices, fetchedAt: priceCache.at });
      return;
    }
    const rows = await Promise.all(
      PRICE_INSTRUMENTS.map(async ({ symbol, instId }): Promise<MarketPrice | null> => {
        const t = await fetchOkxTicker(instId);
        if (!t) return null;
        const change = t.open24h ? ((t.last - t.open24h) / t.open24h) * 100 : null;
        return { symbol, instId, priceUsd: t.last, changePct24h: change };
      }),
    );
    const prices = rows.filter((r): r is MarketPrice => r !== null);
    if (prices.length > 0) priceCache = { at: Date.now(), prices };
    else if (priceCache) {
      // OKX unreachable: serve the last good snapshot instead of an empty board.
      res.json({ prices: priceCache.prices, fetchedAt: priceCache.at, stale: true });
      return;
    }
    res.json({ prices, fetchedAt: Date.now() });
  }),
);

// ---------------------------------------------------------------- GET /api/position/:address
async function positionBundle(address: Address) {
  if (!config.poolAddress) throw new HttpError(503, "pool address not configured");
  const [position, plan] = await Promise.all([
    readPosition(address),
    isGuardConfigured() ? getPlan(address).catch(() => null) : Promise.resolve(null),
  ]);
  let preview: { eligible: boolean; reason: string; hf: number | null; repayAmount: string } | null = null;
  let lastProtectAt: number | null = null;
  let allowance: string | null = null;
  let walletBalance: string | null = null;
  if (plan && isGuardConfigured()) {
    const [pv, last, buf] = await Promise.all([
      previewProtect(address).catch(() => null),
      getLastProtectAt(address).catch(() => null),
      readBuffer(address, plan.debtAsset, config.guardAddress as Address).catch(() => null),
    ]);
    if (pv)
      preview = {
        eligible: pv.eligible,
        reason: pv.reason,
        hf: pv.hf === 0n ? null : hfToNumber(pv.hf) === Infinity ? null : hfToNumber(pv.hf),
        repayAmount: pv.repayAmount.toString(),
      };
    lastProtectAt = last;
    if (buf) {
      const dec = position.reserves.find((r) => r.address === plan.debtAsset.toLowerCase())?.decimals ?? 18;
      allowance = formatUnitsStr(buf.allowance, dec);
      walletBalance = formatUnitsStr(buf.balance, dec);
    }
  }
  return { position, plan, preview, lastProtectAt, allowance, walletBalance };
}

apiRouter.get(
  "/position/:address",
  asyncRoute(async (req, res) => {
    const address = parseAddressParam(req.params.address);
    const b = await positionBundle(address);
    res.json({
      ...positionToJson(b.position),
      plan: planToJson(b.plan),
      allowance: b.allowance,
      walletBalance: b.walletBalance,
      lastProtectAt: b.lastProtectAt,
      preview: b.preview,
      guardAddress: config.guardAddress || null,
    });
  }),
);

// ---------------------------------------------------------------- POST /api/explain
const ExplainBody = z.object({ address: AddressSchema, plan: PlanInputSchema.nullable().optional() });

apiRouter.post(
  "/explain",
  asyncRoute(async (req, res) => {
    const parsed = ExplainBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "invalid body");
    if (!config.poolAddress) throw new HttpError(503, "pool address not configured");
    const { address } = parsed.data;
    const b = await positionBundle(address);
    const pj = positionToJson(b.position);
    // plan for the explainer: the on-chain plan, or the draft the UI sent
    const draft = parsed.data.plan;
    const planLike = b.plan
      ? {
          debtAsset: b.plan.debtAsset.toLowerCase(),
          triggerHf: Number(b.plan.triggerHF) / 1e18,
          targetHf: Number(b.plan.targetHF) / 1e18,
          maxRepayPerProtect: b.plan.maxRepayPerProtect.toString(),
          cooldown: b.plan.cooldown,
          active: b.plan.active,
        }
      : draft && draft.triggerHF !== undefined && draft.targetHF !== undefined
        ? {
            debtAsset: (draft.debtAsset ?? "").toLowerCase(),
            triggerHf: Number(draft.triggerHF),
            targetHf: Number(draft.targetHF),
            maxRepayPerProtect: String(draft.maxRepayPerProtect ?? "0"),
            cooldown: draft.cooldown ?? 600,
            active: draft.active ?? true,
          }
        : null;
    const bufferUsd = (() => {
      if (!b.walletBalance || !b.plan) return undefined;
      const r = pj.reserves.find((x) => x.address === b.plan!.debtAsset.toLowerCase());
      return r ? Number(b.walletBalance) * r.priceUsd : undefined;
    })();
    const [explain, recommend] = await Promise.all([
      explainPosition(pj, planLike),
      recommendPlan(pj, { bufferUsd }),
    ]);
    res.json({
      // flat shape (docs/api.md)
      summary: explain.summary,
      riskLevel: explain.riskLevel,
      liquidationPrices: explain.liquidationPrices,
      recommendation: {
        debtAsset: recommend.debtAsset,
        debtAssetSymbol: recommend.debtAssetSymbol,
        triggerHF: recommend.triggerHF,
        targetHF: recommend.targetHF,
        maxRepayPerProtect: recommend.maxRepayPerProtect,
        maxRepayUsd: recommend.maxRepayUsd,
        bufferUsd: recommend.bufferUsd,
        cooldown: recommend.cooldown,
        rationale: recommend.rationale,
      },
      model: explain.source === "ai" ? explain.model : "rules",
      source: explain.source,
      generatedAt: explain.generatedAt,
      // nested shape
      explain,
      recommend,
    });
  }),
);

// ---------------------------------------------------------------- GET /api/history/:address
apiRouter.get(
  "/history/:address",
  asyncRoute(async (req, res) => {
    const address = parseAddressParam(req.params.address);
    const prots = protections.forAddress(address, 100);
    const snaps = snapshots.recent(address, 200).reverse();
    const reserves = await reservesSafe();
    const meta = (asset: string) => reserves.find((r) => r.address === asset.toLowerCase());
    res.json({
      address: address.toLowerCase(),
      protections: prots.map((p) => {
        const m = meta(p.debt_asset);
        return {
          txHash: p.tx_hash,
          debtAsset: p.debt_asset,
          symbol: m?.symbol ?? null,
          repaid: m ? formatUnitsStr(BigInt(p.repaid), m.decimals) : p.repaid,
          fee: m ? formatUnitsStr(BigInt(p.fee), m.decimals) : p.fee,
          repaidRaw: p.repaid,
          feeRaw: p.fee,
          hfBefore: hfToNumber(BigInt(p.hf_before)),
          hfAfter: hfToNumber(BigInt(p.hf_after)) === Infinity ? null : hfToNumber(BigInt(p.hf_after)),
          keeper: p.keeper,
          block: p.block,
          ts: p.ts,
          txUrl: `${config.explorerBase}/tx/${p.tx_hash}`,
        };
      }),
      snapshots: snaps.map((s) => ({
        ts: s.ts,
        hf: hfStr(s.hf),
        collateralUsd: s.collateral_usd,
        debtUsd: s.debt_usd,
      })),
      plan: (() => {
        const r = plans.get(address);
        return r
          ? {
              debtAsset: r.debt_asset,
              triggerHF: r.trigger_hf,
              targetHF: r.target_hf,
              maxRepayPerProtect: r.max_repay,
              cooldown: r.cooldown,
              active: r.active === 1,
              updatedBlock: r.updated_block,
            }
          : null;
      })(),
    });
  }),
);

// ---------------------------------------------------------------- GET /api/board
apiRouter.get(
  "/board",
  asyncRoute(async (_req, res) => {
    const reserves = await reservesSafe();
    const meta = (asset: string) => reserves.find((r) => r.address === asset.toLowerCase());
    const byAsset = protections.repaidByAsset().map((r) => {
      const m = meta(r.debt_asset);
      const raw = BigInt(Math.round(Number(r.total ?? "0")));
      const amount = m ? formatUnitsStr(raw, m.decimals) : (r.total ?? "0");
      return {
        asset: r.debt_asset,
        symbol: m?.symbol ?? null,
        count: r.n,
        amount,
        usd: m ? Number(amount) * m.priceUsd : null,
      };
    });
    const repaidUsd = byAsset.reduce((a, b) => a + (b.usd ?? 0), 0);
    const recent = protections.recent(20).map((p) => {
      const m = meta(p.debt_asset);
      return {
        address: mask(p.address),
        user: mask(p.address),
        addressFull: p.address,
        addressUrl: `${config.explorerBase}/address/${p.address}`,
        txHash: p.tx_hash,
        txUrl: `${config.explorerBase}/tx/${p.tx_hash}`,
        debtAsset: p.debt_asset,
        symbol: m?.symbol ?? null,
        repaid: m ? formatUnitsStr(BigInt(p.repaid), m.decimals) : p.repaid,
        fee: m ? formatUnitsStr(BigInt(p.fee), m.decimals) : p.fee,
        hfBefore: hfToNumber(BigInt(p.hf_before)),
        hfAfter: hfToNumber(BigInt(p.hf_after)) === Infinity ? null : hfToNumber(BigInt(p.hf_after)),
        keeper: p.keeper,
        ts: p.ts,
      };
    });
    const enrolledRows = protections.enrolled(50).map((r) => ({
      address: mask(r.address),
      addressFull: r.address,
      addressUrl: `${config.explorerBase}/address/${r.address}`,
      protections: r.protections,
      lastHf: hfStr(r.last_hf),
    }));
    res.json({
      chain: config.chain,
      enrolled: plans.countActive(),
      protections: protections.count(),
      repaidUsd: Math.round(repaidUsd * 100) / 100,
      repaidByAsset: byAsset,
      addresses: enrolledRows,
      recent,
      lastIndexedBlock: lastIndexedBlock(),
      sentinel: sentinelStatus(),
    });
  }),
);

// ---------------------------------------------------------------- POST /api/telegram/link
const LinkBody = z.object({ address: AddressSchema });
apiRouter.post(
  "/telegram/link",
  asyncRoute(async (req, res) => {
    const parsed = LinkBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "invalid address");
    if (!telegramEnabled() || !config.telegram.botUsername)
      throw new HttpError(503, "telegram bot not configured");
    // Prefix carries the network so the dark-survivor relay can route /start to the right API.
    const token = `ls${config.chainId}_${randomBytes(12).toString("base64url")}`;
    tgq.createLinkToken(token, parsed.data.address);
    tgq.pruneTokens();
    res.json({
      token,
      deepLink: `https://t.me/${config.telegram.botUsername}?start=${token}`,
      expiresInSeconds: 900,
    });
  }),
);

// ---------------------------------------------------------------- errors → JSON
apiRouter.use((req: Request, res: Response) => {
  res.status(404).json({ error: `not found: ${req.method} ${req.path}` });
});
apiRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message.split("\n")[0] : "internal error";
  log.error({ err: message }, "api error");
  res.status(500).json({ error: message });
});
