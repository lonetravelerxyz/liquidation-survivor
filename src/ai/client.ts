import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";

export type AiProvider = "anthropic" | "openrouter";

export interface AiClient {
  provider: AiProvider;
  model: string;
  /** Returns the raw text completion, or throws. Caller handles fallback. */
  complete(system: string, user: string, opts?: { maxTokens?: number; timeoutMs?: number }): Promise<string>;
}

const log = logger.child({ module: "ai" });

function anthropicClient(): AiClient {
  const sdk = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 1 });
  const model = config.anthropic.model;
  return {
    provider: "anthropic",
    model,
    async complete(system, user, opts = {}) {
      const res = await sdk.messages.create(
        {
          model,
          max_tokens: opts.maxTokens ?? 1024,
          system,
          messages: [{ role: "user", content: user }],
        },
        { timeout: opts.timeoutMs ?? 25_000 },
      );
      if (res.stop_reason === "refusal") throw new Error("model refused");
      const text = res.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (!text) throw new Error("empty completion");
      return text;
    },
  };
}

function openrouterClient(): AiClient {
  const model = config.openrouter.model;
  return {
    provider: "openrouter",
    model,
    async complete(system, user, opts = {}) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25_000);
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            Authorization: `Bearer ${config.openrouter.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": config.publicBaseUrl || "https://github.com/dark-survivor/liquidation-survivor",
            "X-Title": "Liquidation Survivor",
          },
          body: JSON.stringify({
            model,
            max_tokens: opts.maxTokens ?? 1024,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
        });
        if (!res.ok) throw new Error(`openrouter ${res.status}`);
        const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const text = json.choices?.[0]?.message?.content;
        if (!text) throw new Error("empty completion");
        return text;
      } finally {
        clearTimeout(t);
      }
    },
  };
}

let cached: AiClient | null | undefined;

/** Provider by configured keys: Anthropic first, then OpenRouter; null when no key is set. */
export function getAiClient(): AiClient | null {
  if (cached !== undefined) return cached;
  if (config.anthropic.apiKey) cached = anthropicClient();
  else if (config.openrouter.apiKey) cached = openrouterClient();
  else cached = null;
  if (cached) log.info({ provider: cached.provider, model: cached.model }, "ai provider ready");
  else log.info("no AI key set; explain/recommend use the rules engine");
  return cached;
}

/** Pull the first JSON object out of a completion (tolerates code fences / prose around it). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in completion");
  return JSON.parse(cleaned.slice(start, end + 1));
}
