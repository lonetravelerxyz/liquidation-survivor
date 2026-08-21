import type { Bot } from "grammy";
import { telegram as tgq } from "../db/queries.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "telegram" });
let bot: Bot | null = null;

export const setNotifierBot = (b: Bot | null) => {
  bot = b;
};

/** Send `html` to every chat bound to `address`. Swallows all errors; returns number of chats reached. */
export async function sendToAddress(address: string, html: string): Promise<number> {
  if (!bot) return 0;
  let sent = 0;
  for (const b of tgq.bindingsForAddress(address)) {
    try {
      await bot.api.sendMessage(b.chat_id, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      sent++;
    } catch (err) {
      log.warn({ err: (err as Error).message, chatId: b.chat_id }, "telegram send failed");
    }
  }
  return sent;
}

export async function sendToChat(chatId: string | number, html: string): Promise<boolean> {
  if (!bot) return false;
  try {
    await bot.api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (err) {
    log.warn({ err: (err as Error).message, chatId }, "telegram send failed");
    return false;
  }
}
