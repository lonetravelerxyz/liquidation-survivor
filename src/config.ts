import "dotenv/config";

export type ChainKey = "mainnet" | "testnet";

const chain = (process.env.CHAIN ?? "testnet") as ChainKey;
if (chain !== "mainnet" && chain !== "testnet")
  throw new Error(`CHAIN must be mainnet|testnet, got ${chain}`);

const addr = (v: string | undefined): `0x${string}` | "" => (v ? (v as `0x${string}`) : "");
const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined || v === "" ? dflt : !["0", "false", "no", "off"].includes(v.toLowerCase());

const explorerBase =
  chain === "mainnet"
    ? "https://web3.okx.com/explorer/x-layer"
    : "https://web3.okx.com/explorer/x-layer-testnet";

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  databasePath: process.env.DATABASE_PATH ?? "./data/liquidation-survivor.db",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),

  chain,
  chainId: chain === "mainnet" ? 196 : 1952,
  explorerBase,
  rpcUrl:
    chain === "mainnet"
      ? (process.env.XLAYER_RPC_URL ?? "https://rpc.xlayer.tech")
      : (process.env.XLAYER_TESTNET_RPC_URL ?? "https://testrpc.xlayer.tech"),
  guardAddress: addr(
    chain === "mainnet" ? process.env.GUARD_ADDRESS_MAINNET : process.env.GUARD_ADDRESS_TESTNET,
  ),
  poolAddress: addr(
    chain === "mainnet"
      ? (process.env.POOL_ADDRESS_MAINNET ?? "0xE3F3Caefdd7180F884c01E57f65Df979Af84f116")
      : process.env.POOL_ADDRESS_TESTNET,
  ),
  keeperPrivateKey: (process.env.KEEPER_PRIVATE_KEY ?? "") as `0x${string}` | "",
  sentinelEnabled: bool(process.env.SENTINEL_ENABLED, true),
  sentinelIntervalMs: Number(process.env.SENTINEL_INTERVAL_MS ?? 60_000),
  /** Blocks per eth_getLogs request when indexing guard events (X Layer RPC caps ranges). */
  indexerChunkBlocks: Number(process.env.INDEXER_CHUNK_BLOCKS ?? 2000),
  /** First block to index when the sentinel has no saved state (0 = current head minus a small lookback). */
  indexerStartBlock: Number(process.env.INDEXER_START_BLOCK ?? 0),

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    model: process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-5",
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    botUsername: (process.env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, ""),
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
    /** The bot is shared with dark-survivor, which owns the webhook: send only, never register. */
    sharedBot: bool(process.env.TELEGRAM_SHARED_BOT, false),
    /** Bearer secret dark-survivor uses to relay /start /status /unlink to POST /hooks/telegram-update. */
    forwardSecret: process.env.TELEGRAM_FORWARD_SECRET ?? "",
  },

  quicknode: {
    webhookSecurityToken: process.env.QUICKNODE_WEBHOOK_SECURITY_TOKEN ?? "",
  },
} as const;

export const telegramEnabled = (): boolean => Boolean(config.telegram.botToken);
export const keeperEnabled = (): boolean => Boolean(config.keeperPrivateKey && config.guardAddress);
export const aiEnabled = (): boolean => Boolean(config.anthropic.apiKey || config.openrouter.apiKey);
export const guardConfigured = (): boolean => Boolean(config.guardAddress);
export const poolConfigured = (): boolean => Boolean(config.poolAddress);
/** True when PUBLIC_BASE_URL points at a local machine (Telegram cannot reach a webhook there). */
export const isLocalPublicUrl = (): boolean =>
  !config.publicBaseUrl ||
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(config.publicBaseUrl);
