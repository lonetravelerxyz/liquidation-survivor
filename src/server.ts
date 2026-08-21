import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { config, telegramEnabled } from "./config.js";
import { logger } from "./logger.js";
import { apiRouter } from "./routes/api.js";
import { hooksRouter } from "./routes/hooks.js";
import { pagesRouter } from "./routes/pages.js";
import { sentinelStatus } from "./sentinel/loop.js";
import { createBot, telegramWebhookHandler, webhookSecret } from "./telegram/bot.js";

export interface CreateAppOptions {
  /** mount POST /telegram/:secret when a bot token is set (default true) */
  telegram?: boolean;
}

export function createApp(opts: CreateAppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      chain: config.chain,
      guard: config.guardAddress || null,
      sentinel: sentinelStatus(),
      ts: Date.now(),
    });
  });

  app.use("/api", apiRouter);
  app.use("/hooks", hooksRouter);

  if ((opts.telegram ?? true) && telegramEnabled()) {
    const bot = createBot();
    if (bot) {
      const secret = webhookSecret();
      const handler = telegramWebhookHandler(bot);
      app.post("/telegram/:secret", (req, res, next) => {
        if (req.params.secret !== secret) {
          res.status(404).end();
          return;
        }
        handler(req, res).catch(next);
      });
    }
  }

  app.use(pagesRouter);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message.split("\n")[0] : "internal error";
    logger.error({ err: message }, "unhandled error");
    if (res.headersSent) return;
    res.status(500).json({ error: message });
  });
  return app;
}
