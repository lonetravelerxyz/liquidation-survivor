// `pnpm sentinel` — run the loop alone (no HTTP server). Telegram pushes still work when a token is set.
import { logger } from "../logger.js";
import { createBot, startBot, stopBot } from "../telegram/bot.js";
import { startSentinel } from "./loop.js";

const bot = createBot();
if (bot) await startBot(bot);
const sentinel = startSentinel();

const shutdown = async () => {
  logger.info("sentinel shutting down");
  sentinel.stop();
  await stopBot();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
