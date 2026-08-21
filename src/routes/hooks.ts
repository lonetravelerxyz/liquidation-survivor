import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { requestTick } from "../sentinel/loop.js";
import { linkByToken, statusReport, unlinkChat, type Reply } from "../telegram/actions.js";
import { createBot, getBot } from "../telegram/bot.js";

export const hooksRouter = Router();
const log = logger.child({ module: "hooks" });

const authorized = (req: Request): boolean => {
  const expected = config.quicknode.webhookSecurityToken;
  if (!expected) return false;
  const header = req.header("x-qn-security-token");
  if (header && header === expected) return true;
  const auth = req.header("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer ") && auth.slice(7).trim() === expected;
};

/** QuickNode (or any) webhook: verify the shared token, then kick the sentinel. Responds fast. */
hooksRouter.post("/quicknode", (req: Request, res: Response) => {
  if (!config.quicknode.webhookSecurityToken) {
    res.status(503).json({ error: "webhook token not configured" });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const size = Array.isArray(req.body)
    ? req.body.length
    : req.body && typeof req.body === "object"
      ? Object.keys(req.body).length
      : 0;
  log.info({ size }, "quicknode webhook → tick");
  requestTick();
  res.status(200).json({ ok: true });
});

const forwardAuthorized = (req: Request): boolean => {
  const expected = config.telegram.forwardSecret;
  if (!expected) return false;
  const auth = req.header("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer ") && auth.slice(7).trim() === expected;
};

/**
 * Relay target for the shared @dark_survivor_bot: dark-survivor receives the webhook and forwards
 * /start /status /unlink for this deployment here. We reply via sendMessage with the same token
 * (outbound needs no webhook). Responds { replied } so the relay can fall back when we had
 * nothing to say.
 */
hooksRouter.post("/telegram-update", (req: Request, res: Response) => {
  void (async () => {
    if (!config.telegram.forwardSecret) {
      res.status(503).json({ error: "forwarding not configured" });
      return;
    }
    if (!forwardAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = (req.body ?? {}) as { kind?: string; chatId?: number | string; payload?: string };
    const kind = body.kind ?? "";
    const chatId = body.chatId;
    if (!chatId || !["start", "status", "unlink"].includes(kind)) {
      res.status(400).json({ error: "expected { kind: start|status|unlink, chatId, payload? }" });
      return;
    }
    const bot = getBot() ?? createBot();
    if (!bot) {
      res.status(503).json({ error: "telegram not configured" });
      return;
    }
    let reply: Reply | null = null;
    if (kind === "start") reply = linkByToken(chatId, String(body.payload ?? "").trim());
    else if (kind === "status") reply = await statusReport(chatId);
    else reply = unlinkChat(chatId);
    if (reply) {
      await bot.api.sendMessage(chatId, reply.text, {
        parse_mode: reply.html ? "HTML" : undefined,
        link_preview_options: { is_disabled: true },
      });
    }
    log.info({ kind, chatId, replied: Boolean(reply) }, "forwarded telegram update");
    res.json({ replied: Boolean(reply) });
  })().catch((err: unknown) => {
    log.error({ err: (err as Error).message }, "telegram-update failed");
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });
});
