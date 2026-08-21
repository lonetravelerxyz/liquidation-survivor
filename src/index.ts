import { config, telegramEnabled } from "./config.js";
import { logger } from "./logger.js";
import { createApp } from "./server.js";
import { startSentinel } from "./sentinel/loop.js";
import { createBot, startBot, stopBot } from "./telegram/bot.js";

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      chain: config.chain,
      guard: config.guardAddress || null,
      pool: config.poolAddress || null,
    },
    "liquidation survivor listening",
  );
});

const bot = telegramEnabled() ? createBot() : null;
if (bot) void startBot(bot);
const sentinel = startSentinel();

const shutdown = async () => {
  logger.info("shutting down");
  sentinel.stop();
  await stopBot();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
