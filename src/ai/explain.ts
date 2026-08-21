import { createHash } from "node:crypto";
import type { PositionJson } from "../aave/position.js";
import { aiCache } from "../db/queries.js";
import { logger } from "../logger.js";
import { extractJson, getAiClient } from "./client.js";
import {
  DigestSchema,
  ExplainSchema,
  RecommendSchema,
  SYSTEM_PROMPT,
  eventDigestPrompt,
  explainPrompt,
  recommendPrompt,
  type Digest,
  type Explain,
  type Recommend,
} from "./prompts.js";
import { rulesDigest, rulesExplain, rulesRecommend, type EventLike, type PlanLike } from "./rules.js";

export type Source = "ai" | "rules";
export type Sourced<T> = T & { source: Source; model: string; generatedAt: string };

const log = logger.child({ module: "ai" });
export const AI_CACHE_TTL_S = 10 * 60;

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
const cacheKey = (kind: string, address: string, input: unknown) =>
  `${kind}:${address.toLowerCase()}:${hash(input)}`;

/** Stable, coarse view of a position so small price ticks hit the cache (HF bucketed to 0.01, USD to 1). */
const bucket = (p: PositionJson) => ({
  hf: p.hf === null ? null : Math.round(p.hf * 100),
  c: Math.round(p.collateralUsd),
  d: Math.round(p.debtUsd),
  r: p.reserves
    .filter((r) => r.suppliedUsd > 0.5 || r.borrowedUsd > 0.5)
    .map((r) => [r.symbol, Math.round(r.suppliedUsd), Math.round(r.borrowedUsd)]),
});

async function withAi<T>(
  kind: string,
  address: string,
  input: unknown,
  prompt: string,
  schema: { parse: (v: unknown) => T },
  fallback: () => T,
): Promise<Sourced<T>> {
  const key = cacheKey(kind, address, input);
  try {
    const hit = aiCache.get<Sourced<T>>(key, AI_CACHE_TTL_S);
    if (hit) return hit;
  } catch (err) {
    log.warn({ err }, "ai cache read failed");
  }
  const client = getAiClient();
  let result: Sourced<T>;
  if (client) {
    try {
      const text = await client.complete(SYSTEM_PROMPT, prompt, { maxTokens: 1024 });
      const parsed = schema.parse(extractJson(text));
      result = { ...parsed, source: "ai", model: client.model, generatedAt: new Date().toISOString() };
    } catch (err) {
      log.warn({ err: (err as Error).message, kind }, "ai call failed; using rules fallback");
      result = { ...fallback(), source: "rules", model: "rules", generatedAt: new Date().toISOString() };
    }
  } else {
    result = { ...fallback(), source: "rules", model: "rules", generatedAt: new Date().toISOString() };
  }
  try {
    aiCache.put(key, result);
  } catch (err) {
    log.warn({ err }, "ai cache write failed");
  }
  return result;
}

const positionForPrompt = (p: PositionJson) =>
  JSON.stringify({
    hf: p.hf,
    collateralUsd: p.collateralUsd,
    debtUsd: p.debtUsd,
    liquidationThresholdBps: p.liquidationThresholdBps,
    reserves: p.reserves
      .filter((r) => r.suppliedUsd > 0 || r.borrowedUsd > 0)
      .map((r) => ({
        symbol: r.symbol,
        address: r.address,
        decimals: r.decimals,
        priceUsd: r.priceUsd,
        supplied: r.supplied,
        borrowed: r.borrowed,
        suppliedUsd: r.suppliedUsd,
        borrowedUsd: r.borrowedUsd,
        isStable: r.isStable,
      })),
    liquidationPriceHints: p.liquidationPriceHints,
  });

/** Plain-words explanation of the position. Never throws: falls back to the rules engine. */
export async function explainPosition(
  position: PositionJson,
  plan?: PlanLike | null,
): Promise<Sourced<Explain>> {
  const planJson = plan ? JSON.stringify(plan) : null;
  try {
    return await withAi(
      "explain",
      position.address,
      { b: bucket(position), plan: plan ?? null },
      explainPrompt(positionForPrompt(position), planJson),
      ExplainSchema,
      () => rulesExplain(position, plan),
    );
  } catch (err) {
    log.error({ err }, "explainPosition unexpected failure");
    return {
      ...rulesExplain(position, plan),
      source: "rules",
      model: "rules",
      generatedAt: new Date().toISOString(),
    };
  }
}

/** Recommended plan parameters. Never throws. */
export async function recommendPlan(
  position: PositionJson,
  opts: { bufferUsd?: number } = {},
): Promise<Sourced<Recommend>> {
  const baseline = rulesRecommend(position, opts);
  try {
    return await withAi(
      "recommend",
      position.address,
      { b: bucket(position), buf: opts.bufferUsd ?? null },
      recommendPrompt(positionForPrompt(position), JSON.stringify(baseline)),
      RecommendSchema,
      () => baseline,
    );
  } catch (err) {
    log.error({ err }, "recommendPlan unexpected failure");
    return { ...baseline, source: "rules", model: "rules", generatedAt: new Date().toISOString() };
  }
}

/** One-paragraph digest of a sentinel event for Telegram. Never throws. */
export async function digestEvent(event: EventLike): Promise<Sourced<Digest>> {
  try {
    return await withAi(
      "digest",
      event.address,
      event,
      eventDigestPrompt(JSON.stringify(event)),
      DigestSchema,
      () => rulesDigest(event),
    );
  } catch (err) {
    log.error({ err }, "digestEvent unexpected failure");
    return { ...rulesDigest(event), source: "rules", model: "rules", generatedAt: new Date().toISOString() };
  }
}
