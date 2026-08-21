import { isAddress } from "viem";
import { readPosition } from "../aave/position.js";
import { config } from "../config.js";
import { telegram as tgq } from "../db/queries.js";
import { getPlan, isGuardConfigured } from "../guard/reads.js";
import { logger } from "../logger.js";
import { templates } from "./templates.js";

const log = logger.child({ module: "telegram" });

export interface Reply {
  text: string;
  html?: boolean;
}

/**
 * Command logic shared by the grammY handlers (local long-polling) and the forwarded-update
 * endpoint (production, where @dark_survivor_bot's webhook lives in the dark-survivor service
 * and relays /start /status /unlink here).
 */
export function linkByToken(chatId: number | string, token: string): Reply {
  const address = tgq.consumeLinkToken(token);
  if (!address)
    return { text: "That link is unknown or expired. Open the app and press “Link Telegram” again." };
  tgq.bind(address, chatId);
  log.info({ chatId, address }, "telegram linked");
  return { text: templates.linked(address), html: true };
}

/** null when nothing is linked to this chat — lets the relay fall back instead of double-replying. */
export async function statusReport(chatId: number | string): Promise<Reply | null> {
  const bindings = tgq.bindingsForChat(chatId);
  if (bindings.length === 0) return null;
  const rows = await Promise.all(
    bindings.map(async (b) => {
      let hf: number | null = null;
      let planActive: boolean | null = null;
      let triggerHf: number | null = null;
      try {
        if (isAddress(b.address) && config.poolAddress) {
          const pos = await readPosition(b.address as `0x${string}`);
          hf = Number.isFinite(pos.hf) ? pos.hf : null;
        }
        if (isGuardConfigured()) {
          const plan = await getPlan(b.address as `0x${string}`);
          planActive = plan ? plan.active : null;
          triggerHf = plan ? Number(plan.triggerHF) / 1e18 : null;
        }
      } catch (err) {
        log.warn({ err: (err as Error).message, address: b.address }, "status read failed");
      }
      return { address: b.address, hf, planActive, triggerHf };
    }),
  );
  return { text: templates.status(rows), html: true };
}

/** null when nothing was linked. */
export function unlinkChat(chatId: number | string): Reply | null {
  const n = tgq.unbindChat(chatId);
  return n > 0 ? { text: `Removed ${n} wallet link(s) from this chat.` } : null;
}
