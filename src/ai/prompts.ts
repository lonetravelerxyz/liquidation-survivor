import { z } from "zod";

export const SYSTEM_PROMPT = `You are Liquidation Survivor's AI: a careful DeFi risk explainer for Aave V3 borrowers on X Layer.
Rules:
- Explain in short, plain sentences. No hype, no promises, no financial advice; say "may" and "roughly".
- Use only the numbers given to you. Never invent balances, prices or addresses.
- Health factor (HF) below 1.0 means the position can be liquidated. Aave on X Layer charges roughly a 5-10% liquidation bonus on the collateral seized.
- The SurvivalGuard contract can only repay the user's own debt from a stablecoin buffer the user approved; it never moves funds elsewhere.
- Output MUST be a single JSON object that matches the requested schema exactly. No markdown, no code fences, no commentary.`;

// ---------------------------------------------------------------- schemas (what the model must return)
export const RiskLevel = z.enum(["safe", "watch", "danger"]);

export const ExplainSchema = z.object({
  summary: z.string().min(1).max(600),
  riskLevel: RiskLevel,
  liquidationPrices: z
    .array(z.object({ symbol: z.string(), price: z.number().nullable(), dropPct: z.number().nullable() }))
    .default([]),
  estimatedPenaltyUsd: z.object({ min: z.number(), max: z.number() }).nullable().default(null),
  bullets: z.array(z.string().max(200)).max(6).default([]),
});
export type Explain = z.infer<typeof ExplainSchema>;

export const RecommendSchema = z.object({
  debtAsset: z.string().nullable(),
  debtAssetSymbol: z.string().nullable(),
  triggerHF: z.number().min(1).max(5),
  targetHF: z.number().min(1.01).max(10),
  /** debt-asset token units as a decimal string */
  maxRepayPerProtect: z.string(),
  maxRepayUsd: z.number().min(0),
  bufferUsd: z.number().min(0),
  cooldown: z.number().int().min(60).max(86_400),
  rationale: z.array(z.string().max(240)).min(1).max(6),
});
export type Recommend = z.infer<typeof RecommendSchema>;

export const DigestSchema = z.object({
  text: z.string().min(1).max(400),
});
export type Digest = z.infer<typeof DigestSchema>;

// ---------------------------------------------------------------- task prompts
export const explainPrompt = (
  positionJson: string,
  planJson: string | null,
) => `Task: explain this Aave position to its owner.
Position (JSON): ${positionJson}
Current protection plan (JSON or null): ${planJson ?? "null"}

Return JSON with this exact shape:
{"summary": string (2-3 sentences, plain words),
 "riskLevel": "safe" | "watch" | "danger"  (safe: HF >= 1.5 or no debt; watch: 1.15 <= HF < 1.5; danger: HF < 1.15),
 "liquidationPrices": [{"symbol": string, "price": number|null, "dropPct": number|null}]  (copy from liquidationPriceHints),
 "estimatedPenaltyUsd": {"min": number, "max": number} | null  (roughly 5-10% of total debt USD; null when no debt),
 "bullets": [up to 4 short facts the owner should know]}`;

export const recommendPrompt = (
  positionJson: string,
  rulesJson: string,
) => `Task: recommend SurvivalGuard plan parameters for this Aave position.
Position (JSON): ${positionJson}
Deterministic baseline computed by our rules engine (JSON): ${rulesJson}

Keep the baseline's debtAsset, maxRepayPerProtect, maxRepayUsd and bufferUsd unless the position clearly calls for a change; you may tune triggerHF (1.05-1.30) and targetHF (1.25-1.60) and write the rationale.
Return JSON with this exact shape:
{"debtAsset": string|null, "debtAssetSymbol": string|null, "triggerHF": number, "targetHF": number,
 "maxRepayPerProtect": string (token units, decimal string), "maxRepayUsd": number, "bufferUsd": number,
 "cooldown": integer seconds, "rationale": [2-4 short sentences]}`;

export const eventDigestPrompt = (
  eventJson: string,
) => `Task: write a short Telegram message (max 3 sentences, plain words, no markdown) telling the owner what just happened.
Event (JSON): ${eventJson}
Return JSON: {"text": string}`;
