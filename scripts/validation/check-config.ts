// pnpm exec tsx scripts/validation/check-config.ts — print the effective config (secrets masked) and probe the RPC.
import { createPublicClient, http } from "viem";
import { aiEnabled, config, keeperEnabled, telegramEnabled } from "../../src/config.js";
import { xlayer, xlayerTestnet } from "../../src/chains/xlayer.js";
import { getKeeperAccount } from "../../src/guard/client.js";

const mask = (v: string) => (v ? `set (${v.length} chars)` : "unset");

const view = {
  chain: config.chain,
  chainId: config.chainId,
  rpcUrl: config.rpcUrl,
  explorerBase: config.explorerBase,
  guardAddress: config.guardAddress || null,
  poolAddress: config.poolAddress || null,
  keeper: keeperEnabled() ? getKeeperAccount()?.address : "disabled",
  keeperPrivateKey: mask(config.keeperPrivateKey),
  sentinel: {
    enabled: config.sentinelEnabled,
    intervalMs: config.sentinelIntervalMs,
    chunkBlocks: config.indexerChunkBlocks,
  },
  ai: {
    enabled: aiEnabled(),
    anthropicKey: mask(config.anthropic.apiKey),
    anthropicModel: config.anthropic.model,
    openrouterKey: mask(config.openrouter.apiKey),
    openrouterModel: config.openrouter.model,
  },
  telegram: {
    enabled: telegramEnabled(),
    token: mask(config.telegram.botToken),
    username: config.telegram.botUsername || null,
    webhookSecret: mask(config.telegram.webhookSecret),
  },
  quicknodeToken: mask(config.quicknode.webhookSecurityToken),
  publicBaseUrl: config.publicBaseUrl || null,
  databasePath: config.databasePath,
  port: config.port,
};
console.log(JSON.stringify(view, null, 2));

const client = createPublicClient({
  chain: config.chain === "mainnet" ? xlayer : xlayerTestnet,
  transport: http(config.rpcUrl, { timeout: 10_000 }),
});
try {
  const [rpcChainId, head] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  console.log(
    `rpc chainId=${rpcChainId} head=${head} ${rpcChainId === config.chainId ? "OK" : `MISMATCH (expected ${config.chainId})`}`,
  );
  if (config.guardAddress) {
    const code = await client.getCode({ address: config.guardAddress });
    console.log(
      `guard code: ${code && code !== "0x" ? `${(code.length - 2) / 2} bytes` : "NONE (not deployed at this address)"}`,
    );
  }
  if (config.poolAddress) {
    const code = await client.getCode({ address: config.poolAddress });
    console.log(`pool code: ${code && code !== "0x" ? `${(code.length - 2) / 2} bytes` : "NONE"}`);
  }
  const k = getKeeperAccount();
  if (k) console.log(`keeper balance: ${Number(await client.getBalance({ address: k.address })) / 1e18} OKB`);
} catch (err) {
  console.error("rpc probe failed:", (err as Error).message);
  process.exitCode = 1;
}
