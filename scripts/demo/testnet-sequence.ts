/**
 * Testnet demo: derive N borrower wallets from the deployer key, fund them, supply xETH / borrow USDT on
 * MockPool, approve the guard + enroll, dip the xETH price, then run the keeper on whoever became eligible.
 *
 *   pnpm demo:testnet -- --users 3 --dip 0.2 [--hf 1.3] [--fund 0.002] [--restore] [--no-protect]
 *
 * Env: DEPLOYER_PRIVATE_KEY (MockPool owner), POOL_ADDRESS_TESTNET, GUARD_ADDRESS_TESTNET,
 *      USDT_ADDRESS, XETH_ADDRESS (or --usdt/--xeth), KEEPER_PRIVATE_KEY (falls back to deployer with a warning),
 *      XLAYER_TESTNET_RPC_URL. Every step is non-fatal and idempotent-ish (re-running skips what is already done).
 */
import "dotenv/config";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  keccak256,
  parseEther,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xlayerTestnet } from "../../src/chains/xlayer.js";
import { ERC20_ABI, MOCK_POOL_ABI, SURVIVAL_GUARD_ABI } from "../../src/guard/abi.js";

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : "true";
  return dflt;
};
const USERS = Number(arg("users", "3"));
const DIP = Number(arg("dip", "0.2"));
const START_HF = Number(arg("hf", "1.3"));
const FUND_OKB = arg("fund", "0.002")!;
const RESTORE = arg("restore") === "true";
const PROTECT = arg("no-protect") !== "true";
const TRIGGER_HF = Number(arg("trigger", "1.15"));
const TARGET_HF = Number(arg("target", "1.4"));
const COOLDOWN = Number(arg("cooldown", "60"));

const env = (k: string) => process.env[k] ?? "";
const POOL = (arg("pool") ?? env("POOL_ADDRESS_TESTNET")) as Address;
const GUARD = (arg("guard") ?? env("GUARD_ADDRESS_TESTNET")) as Address;
const USDT = (arg("usdt") ?? env("USDT_ADDRESS")) as Address;
const XETH = (arg("xeth") ?? env("XETH_ADDRESS")) as Address;
const RPC = env("XLAYER_TESTNET_RPC_URL") || "https://testrpc.xlayer.tech";
const DEPLOYER_KEY = env("DEPLOYER_PRIVATE_KEY") as Hex;
const KEEPER_KEY = (env("KEEPER_PRIVATE_KEY") || DEPLOYER_KEY) as Hex;

for (const [k, v] of Object.entries({ POOL, GUARD, USDT, XETH, DEPLOYER_KEY })) {
  if (!v) {
    console.error(`missing ${k} (env or --flag)`);
    process.exit(1);
  }
}
if (!env("KEEPER_PRIVATE_KEY"))
  console.warn("WARN: KEEPER_PRIVATE_KEY unset → using deployer as keeper (demo only)");

// ---------------------------------------------------------------- clients
const publicClient = createPublicClient({ chain: xlayerTestnet, transport: http(RPC, { timeout: 30_000 }) });
const deployer = privateKeyToAccount(DEPLOYER_KEY);
const keeper = privateKeyToAccount(KEEPER_KEY);
const wallet = (key: Hex) =>
  createWalletClient({
    account: privateKeyToAccount(key),
    chain: xlayerTestnet,
    transport: http(RPC, { timeout: 30_000 }),
  });
const deployerWallet = wallet(DEPLOYER_KEY);
const keeperWallet = wallet(KEEPER_KEY);

/** Deterministic demo borrowers: keccak(deployerKey ‖ index). Re-runs reuse the same wallets. */
const userKey = (i: number): Hex => keccak256(concatHex([DEPLOYER_KEY, toHex(i, { size: 32 })]));

interface Row {
  step: string;
  who: string;
  tx: string;
  note: string;
}
const rows: Row[] = [];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const record = (step: string, who: string, tx: string, note = "") => {
  rows.push({ step, who, tx, note });
  console.log(`  ${step.padEnd(14)} ${who.padEnd(12)} ${tx.padEnd(66)} ${note}`);
};

async function send(
  w: ReturnType<typeof wallet>,
  step: string,
  fn: () => Promise<Hex>,
  note = "",
): Promise<Hex | null> {
  const who = short(w.account.address);
  try {
    const hash = await fn();
    const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    record(step, who, hash, `${r.status === "success" ? "ok" : "REVERTED"} ${note}`.trim());
    return r.status === "success" ? hash : null;
  } catch (err) {
    record(step, who, "-", `FAILED: ${(err as Error).message.split("\n")[0]?.slice(0, 90)}`);
    return null;
  }
}

const read = {
  price: (asset: Address) =>
    publicClient.readContract({
      address: POOL,
      abi: MOCK_POOL_ABI,
      functionName: "getAssetPrice",
      args: [asset],
    }),
  decimals: (t: Address) =>
    publicClient.readContract({ address: t, abi: ERC20_ABI, functionName: "decimals", args: [] }),
  bal: (t: Address, a: Address) =>
    publicClient.readContract({ address: t, abi: ERC20_ABI, functionName: "balanceOf", args: [a] }),
  allowance: (t: Address, o: Address, s: Address) =>
    publicClient.readContract({ address: t, abi: ERC20_ABI, functionName: "allowance", args: [o, s] }),
  account: (u: Address) =>
    publicClient.readContract({
      address: POOL,
      abi: MOCK_POOL_ABI,
      functionName: "getUserAccountData",
      args: [u],
    }),
  plan: (u: Address) =>
    publicClient.readContract({ address: GUARD, abi: SURVIVAL_GUARD_ABI, functionName: "plans", args: [u] }),
  preview: (u: Address) =>
    publicClient.readContract({
      address: GUARD,
      abi: SURVIVAL_GUARD_ABI,
      functionName: "previewProtect",
      args: [u],
    }),
};

const hf = (v: bigint) => (v > 10n ** 30n ? "∞" : (Number(v) / 1e18).toFixed(3));

// ---------------------------------------------------------------- main
console.log(`pool=${POOL} guard=${GUARD} usdt=${USDT} xeth=${XETH}`);
console.log(
  `deployer=${deployer.address} keeper=${keeper.address} users=${USERS} dip=${DIP} startHF=${START_HF}`,
);

const usdtDec = Number(await read.decimals(USDT));
const xethDec = Number(await read.decimals(XETH));
const xethPrice0 = await read.price(XETH);
console.log(`xETH price now: $${formatUnits(xethPrice0, 8)}`);

const users = Array.from({ length: USERS }, (_, i) => ({
  key: userKey(i + 1),
  account: privateKeyToAccount(userKey(i + 1)),
}));

// 1) fund with OKB
console.log("\n[1] fund demo wallets");
for (const u of users) {
  const bal = await publicClient.getBalance({ address: u.account.address });
  if (bal >= parseEther(FUND_OKB) / 2n) {
    record("fund", short(u.account.address), "-", `skip (has ${formatUnits(bal, 18)} OKB)`);
    continue;
  }
  await send(
    deployerWallet,
    "fund",
    () => deployerWallet.sendTransaction({ to: u.account.address, value: parseEther(FUND_OKB) }),
    `${FUND_OKB} OKB`,
  );
}

// 2) mint mock tokens (open mint; deployer pays gas)
console.log("\n[2] mint xETH collateral + USDT buffer");
const SUPPLY_XETH = parseUnits("1", xethDec);
const BUFFER_USDT = parseUnits("600", usdtDec);
for (const u of users) {
  const [x, s] = await Promise.all([read.bal(XETH, u.account.address), read.bal(USDT, u.account.address)]);
  if (x < SUPPLY_XETH)
    await send(deployerWallet, "mint xETH", () =>
      deployerWallet.writeContract({
        address: XETH,
        abi: ERC20_ABI,
        functionName: "mint",
        args: [u.account.address, SUPPLY_XETH],
      }),
    );
  else record("mint xETH", short(u.account.address), "-", "skip");
  if (s < BUFFER_USDT)
    await send(deployerWallet, "mint USDT", () =>
      deployerWallet.writeContract({
        address: USDT,
        abi: ERC20_ABI,
        functionName: "mint",
        args: [u.account.address, BUFFER_USDT],
      }),
    );
  else record("mint USDT", short(u.account.address), "-", "skip");
}

// 3) supply + borrow to reach START_HF
console.log(`\n[3] supply 1 xETH, borrow USDT to HF≈${START_HF}`);
for (const u of users) {
  const w = wallet(u.key);
  const acct = await read.account(u.account.address);
  if (acct[1] > 0n) {
    record(
      "supply/borrow",
      short(u.account.address),
      "-",
      `skip (debt ${formatUnits(acct[1], 8)} USD, hf ${hf(acct[5])})`,
    );
    continue;
  }
  if (acct[0] === 0n) {
    const allowance = await read.allowance(XETH, u.account.address, POOL);
    if (allowance < SUPPLY_XETH)
      await send(w, "approve xETH", () =>
        w.writeContract({
          address: XETH,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [POOL, SUPPLY_XETH * 100n],
        }),
      );
    await send(
      w,
      "supply",
      () =>
        w.writeContract({
          address: POOL,
          abi: MOCK_POOL_ABI,
          functionName: "supply",
          args: [XETH, SUPPLY_XETH, u.account.address, 0],
        }),
      "1 xETH",
    );
  }
  // RPC nodes behind the load balancer can lag a block or two: wait until the supply is visible.
  let after = await read.account(u.account.address);
  for (let i = 0; i < 8 && after[0] === 0n; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    after = await read.account(u.account.address);
  }
  if (after[0] === 0n) {
    record("borrow", short(u.account.address), "-", "skip (collateral not visible yet; re-run)");
    continue;
  }
  // debt allowed at START_HF: collateral * LT / START_HF  (base 1e8 USD); USDT price from the pool
  const usdtPrice = await read.price(USDT);
  const debtBase = ((after[0] * after[3]) / 10_000n / BigInt(Math.round(START_HF * 1000))) * 1000n;
  const borrowAmt = (debtBase * 10n ** BigInt(usdtDec)) / usdtPrice;
  if (borrowAmt > 0n)
    await send(
      w,
      "borrow",
      () =>
        w.writeContract({
          address: POOL,
          abi: MOCK_POOL_ABI,
          functionName: "borrow",
          args: [USDT, borrowAmt, 2n, 0, u.account.address],
        }),
      `${formatUnits(borrowAmt, usdtDec)} USDT`,
    );
}

// 4) approve guard + enroll
console.log(
  `\n[4] approve USDT → guard, enroll (trigger ${TRIGGER_HF}, target ${TARGET_HF}, cooldown ${COOLDOWN}s)`,
);
const MAX_REPAY = parseUnits("400", usdtDec);
for (const u of users) {
  const w = wallet(u.key);
  const allowance = await read.allowance(USDT, u.account.address, GUARD);
  if (allowance < MAX_REPAY)
    await send(w, "approve guard", () =>
      w.writeContract({
        address: USDT,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [GUARD, (1n << 256n) - 1n],
      }),
    );
  else record("approve guard", short(u.account.address), "-", "skip");
  const plan = await read.plan(u.account.address);
  if (plan.active && plan.debtAsset.toLowerCase() === USDT.toLowerCase()) {
    record("enroll", short(u.account.address), "-", "skip (active)");
    continue;
  }
  await send(w, "enroll", () =>
    w.writeContract({
      address: GUARD,
      abi: SURVIVAL_GUARD_ABI,
      functionName: "enroll",
      args: [
        {
          debtAsset: USDT,
          triggerHF: parseEther(String(TRIGGER_HF)),
          targetHF: parseEther(String(TARGET_HF)),
          maxRepayPerProtect: MAX_REPAY,
          cooldown: COOLDOWN,
          active: true,
        },
      ],
    }),
  );
}

// 5) dip the price
console.log(`\n[5] owner setPrice xETH −${DIP * 100}%`);
const dipped = (xethPrice0 * BigInt(Math.round((1 - DIP) * 10_000))) / 10_000n;
if (DIP > 0)
  await send(
    deployerWallet,
    "setPrice",
    () =>
      deployerWallet.writeContract({
        address: POOL,
        abi: MOCK_POOL_ABI,
        functionName: "setPrice",
        args: [XETH, dipped],
      }),
    `$${formatUnits(xethPrice0, 8)} → $${formatUnits(dipped, 8)}`,
  );

// The public testnet RPC is load-balanced and a read straight after the receipt can hit a lagging
// replica; wait until the dipped price is actually visible before judging eligibility.
if (DIP > 0) {
  for (let i = 0; i < 30; i++) {
    if ((await read.price(XETH)) === dipped) break;
    if (i === 29) console.log("  warn: dipped price still not visible after 60s; continuing");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

for (const u of users) {
  const [acct, pv] = await Promise.all([read.account(u.account.address), read.preview(u.account.address)]);
  console.log(
    `  ${short(u.account.address)} hf=${hf(acct[5])} eligible=${pv[0]} reason="${pv[1]}" repay=${formatUnits(pv[3], usdtDec)} USDT`,
  );
}

// 6) keeper protect
if (PROTECT) {
  console.log("\n[6] keeper protect (eligible only)");
  for (const u of users) {
    let pv = await read.preview(u.account.address);
    for (let i = 0; i < 5 && !pv[0]; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      pv = await read.preview(u.account.address);
    }
    if (!pv[0]) {
      record("protect", short(u.account.address), "-", `skip (${pv[1]})`);
      continue;
    }
    const before = hf(pv[2]);
    const h = await send(keeperWallet, "protect", () =>
      keeperWallet.writeContract({
        address: GUARD,
        abi: SURVIVAL_GUARD_ABI,
        functionName: "protect",
        args: [u.account.address],
      }),
    );
    if (h) {
      const acct = await read.account(u.account.address);
      console.log(`    hf ${before} → ${hf(acct[5])}`);
    }
  }
}

// 7) optional restore
if (RESTORE && DIP > 0) {
  console.log("\n[7] restore xETH price");
  await send(
    deployerWallet,
    "setPrice",
    () =>
      deployerWallet.writeContract({
        address: POOL,
        abi: MOCK_POOL_ABI,
        functionName: "setPrice",
        args: [XETH, xethPrice0],
      }),
    `back to $${formatUnits(xethPrice0, 8)}`,
  );
}

console.log("\n=== summary ===");
console.table(
  rows.filter((r) => r.tx !== "-").map((r) => ({ step: r.step, who: r.who, tx: r.tx, note: r.note })),
);
console.log(`explorer: https://web3.okx.com/explorer/x-layer-testnet/tx/<hash>`);
