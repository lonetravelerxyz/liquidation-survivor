import { Bot, webhookCallback } from "grammy";
import { createHash } from "node:crypto";
import { config, isLocalPublicUrl, telegramEnabled } from "../config.js";
import { logger } from "../logger.js";
import { linkByToken, statusReport, unlinkChat } from "./actions.js";
import { setNotifierBot } from "./notify.js";
import { templates } from "./templates.js";

const log = logger.child({ module: "telegram" });
let bot: Bot | null = null;

/** Webhook path secret: explicit TELEGRAM_WEBHOOK_SECRET or a hash of the token (never the token itself). */
export const webhookSecret = (): string =>
  config.telegram.webhookSecret ||
  createHash("sha256").update(config.telegram.botToken).digest("hex").slice(0, 32);

export function createBot(): Bot | null {
  if (!telegramEnabled()) return null;
  if (bot) return bot;
  bot = new Bot(config.telegram.botToken);

  bot.command("start", async (ctx) => {
    const token = (ctx.match ?? "").trim();
    if (!token) return ctx.reply(templates.help(), { parse_mode: "HTML" });
    const reply = linkByToken(ctx.chat.id, token);
    return ctx.reply(reply.text, {
      parse_mode: reply.html ? "HTML" : undefined,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("status", async (ctx) => {
    const reply = (await statusReport(ctx.chat.id)) ?? { text: templates.status([]), html: true };
    return ctx.reply(reply.text, {
      parse_mode: reply.html ? "HTML" : undefined,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("unlink", async (ctx) => {
    const reply = unlinkChat(ctx.chat.id) ?? { text: "Nothing was linked to this chat." };
    return ctx.reply(reply.text);
  });

  bot.command("help", (ctx) => ctx.reply(templates.help(), { parse_mode: "HTML" }));

  bot.catch((err) => log.error({ err: err.error }, "telegram handler error"));
  setNotifierBot(bot);
  return bot;
}

export const getBot = (): Bot | null => bot;

/** Express handler for POST /telegram/:secret */
export const telegramWebhookHandler = (b: Bot) =>
  webhookCallback(b, "express", { timeoutMilliseconds: 25_000 });

/**
 * Start receiving updates: long polling when PUBLIC_BASE_URL is local/unset, otherwise register the webhook.
 * Never throws — Telegram being down must not stop the server.
 */
export async function startBot(b: Bot): Promise<void> {
  try {
    await b.init();
    if (config.telegram.sharedBot) {
      // dark-survivor owns this bot's webhook; we only send. Registering a webhook or polling
      // here would hijack updates from the live product.
      log.info({ username: b.botInfo.username }, "telegram shared-bot mode: outbound only");
      return;
    }
    if (isLocalPublicUrl()) {
      await b.api.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
      void b.start({ onStart: (me) => log.info({ username: me.username }, "telegram long polling started") });
    } else {
      const url = `${config.publicBaseUrl}/telegram/${webhookSecret()}`;
      await b.api.setWebhook(url, { drop_pending_updates: false });
      log.info({ username: b.botInfo.username }, "telegram webhook registered");
    }
  } catch (err) {
    log.error({ err: (err as Error).message }, "telegram start failed (continuing without bot updates)");
  }
}

export async function stopBot(): Promise<void> {
  if (bot?.isRunning()) await bot.stop().catch(() => undefined);
}
