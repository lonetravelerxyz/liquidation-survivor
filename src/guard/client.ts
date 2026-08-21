import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { config } from "../config.js";
import { xlayer, xlayerTestnet } from "../chains/xlayer.js";

export const chain: Chain = config.chain === "mainnet" ? xlayer : xlayerTestnet;

/** Read-only client for the configured chain (RPC from config). */
export const publicClient: PublicClient = createPublicClient({
  chain,
  transport: http(config.rpcUrl, { timeout: 20_000, retryCount: 2 }),
});

let keeperAccount: PrivateKeyAccount | null = null;
let keeperWallet: WalletClient | null = null;

/** Keeper signer — gas dust only, calls `protect`. Null when KEEPER_PRIVATE_KEY is unset. */
export const getKeeperAccount = (): PrivateKeyAccount | null => {
  if (!config.keeperPrivateKey) return null;
  if (!keeperAccount) keeperAccount = privateKeyToAccount(config.keeperPrivateKey);
  return keeperAccount;
};

export const getKeeperWallet = (): WalletClient | null => {
  const account = getKeeperAccount();
  if (!account) return null;
  if (!keeperWallet) {
    keeperWallet = createWalletClient({
      account,
      chain,
      transport: http(config.rpcUrl, { timeout: 20_000 }),
    });
  }
  return keeperWallet;
};

/** Run async jobs with bounded concurrency (X Layer RPCs throttle bursts and batches). */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}
