# HTTP API (server → browser / Telegram)

All JSON. Addresses are lowercase hex (inputs accept any case; checksum-validated). Token amounts are decimal
strings in token units unless a field is named `…Raw` (integer string) or `…Usd` (number). Health factors are
numbers; `null` means "no debt" (on-chain `max uint`). Errors are `{ error: string }` with 400 (bad input),
404, 503 (chain piece not configured) or 500. The frontend at `src/views/` is the only intended consumer;
shapes are still contracts — change with a doc update. Where the scaffold named a field one way and the
implementation another, both names are returned (e.g. `guard` and `guardAddress`, `hf` and `healthFactor`).

## Endpoints

### `GET /healthz`

`{ ok: true, chain, guard, sentinel: {running, lastTickAt, tickCount, enabled}, ts }`

### `GET /api/config`

```
{ chain: "mainnet" | "testnet", chainId, rpcUrl, explorerBase,
  guard, guardAddress,            // same value; null until deployed
  pool, poolAddress, oracle,      // testnet: oracle == MockPool
  feeBps, paused,                 // null when the guard is not configured / unreachable
  reserves: [{ symbol, address, decimals, aToken, vToken, priceUsd, isStable, stable }],
  guardAbi, erc20Abi,             // viem ABIs for the browser
  telegramBotUsername, telegramEnabled, aiEnabled, keeperEnabled, sentinel }
```

Always 200, even with empty addresses (testnet before deploy): then `reserves: []`, `guardAddress: null`.

### `GET /api/prices`

Live spot prices for the volatile demo assets, proxied from OKX market tickers (their API has no
CORS headers, so the browser cannot fetch it directly). Cached ~5s server-side.

```
{ prices: [{ symbol, instId, priceUsd, changePct24h }],   // symbol: xETH | xBTC | WOKB
  fetchedAt,                                              // ms epoch of the OKX read
  stale? }                                                // true when serving the last good
                                                          // snapshot because OKX was unreachable
```

Always 200; `prices` may be empty on a cold start with OKX unreachable.

### `GET /api/position/:address`

```
{ address, chain,
  healthFactor, hf,                         // number | null (no debt)
  totalCollateralUsd, collateralUsd, totalDebtUsd, debtUsd, liquidationThresholdBps, ltvBps,
  reserves: [{ symbol, address, decimals, aToken, vToken, price, priceUsd, isStable,
               supplied, borrowed, suppliedUsd, borrowedUsd, liquidationThresholdBps }],
  liquidationPriceHints: [{ symbol, currentPrice, liquidationPrice, dropPct }],   // null = no single-asset liq.
  plan: null | { debtAsset, triggerHF, targetHF, maxRepayPerProtect, cooldown, active, triggerHf, targetHf },
                                            // triggerHF/targetHF 1e18 strings; triggerHf/targetHf numbers
  allowance, walletBalance,                 // buffer (plan.debtAsset) — null without a plan
  lastProtectAt,                            // unix seconds, 0 = never, null without a plan
  preview: null | { eligible, reason, hf, repayAmount },   // SurvivalGuard.previewProtect
  guardAddress, fetchedAt }
```

503 when the pool is not configured.

### `POST /api/explain` `{ address, plan? }`

`plan` (optional draft from the UI): `{ debtAsset?, triggerHF?, targetHF?, maxRepayPerProtect?, cooldown? }`.
Returns the flat report plus the two nested objects it is made of:

```
{ summary, riskLevel: "safe" | "watch" | "danger",
  liquidationPrices: [{ symbol, price, dropPct }],
  recommendation: { debtAsset, debtAssetSymbol, triggerHF, targetHF, maxRepayPerProtect, maxRepayUsd,
                    bufferUsd, cooldown, rationale: string[] },
  model,                       // model id, or "rules"
  source: "ai" | "rules", generatedAt,
  explain:   { summary, riskLevel, liquidationPrices, estimatedPenaltyUsd: {min,max}|null, bullets[], source, model, generatedAt },
  recommend: { ...recommendation, source, model, generatedAt } }
```

Cached 10 min per address + HF bucket (`ai_cache`). Never 500s on AI failure: no key, network error or invalid
JSON → deterministic rules result with `source: "rules"`. Provider: `ANTHROPIC_API_KEY` (Anthropic SDK) else
`OPENROUTER_API_KEY` (chat completions, `OPENROUTER_MODEL`), else rules.

### `GET /api/history/:address`

```
{ address,
  protections: [{ txHash, debtAsset, symbol, repaid, fee, repaidRaw, feeRaw, hfBefore, hfAfter, keeper, block, ts, txUrl }],
  snapshots:   [{ ts, hf, collateralUsd, debtUsd }],      // last 200, oldest first
  plan: null | { debtAsset, triggerHF, targetHF, maxRepayPerProtect, cooldown, active, updatedBlock } }  // indexed copy
```

### `GET /api/board`

```
{ chain, enrolled, protections, repaidUsd,
  repaidByAsset: [{ asset, symbol, count, amount, usd }],
  addresses: [{ address (masked), addressFull, addressUrl, protections, lastHf }],   // active plans
  recent: [{ address, user (masked), addressFull, addressUrl, txHash, txUrl, debtAsset, symbol, repaid, fee, hfBefore, hfAfter, keeper, ts }],
  lastIndexedBlock, sentinel }
```

### `POST /api/telegram/link` `{ address }`

`{ token, deepLink: "https://t.me/<bot>?start=<token>", expiresInSeconds }` — the bot's `/start <token>`
binds chat ↔ address (15 min TTL, single use). 503 when the bot is not configured.

### `POST /hooks/quicknode`

Verifies `x-qn-security-token` (or `Authorization: Bearer …`) against `QUICKNODE_WEBHOOK_SECURITY_TOKEN`,
then triggers an immediate sentinel tick. 200 `{ ok: true }`; 401 bad token; 503 token not configured.

### `POST /telegram/:secret`

grammY webhook (only when `TELEGRAM_BOT_TOKEN` is set and `PUBLIC_BASE_URL` is not local; local dev uses
long polling). `secret` = `TELEGRAM_WEBHOOK_SECRET` or a hash of the token.

Server-rendered pages: `GET /` (app), `GET /board` (public Survival Board), `/static/*` assets.

## Telegram bot commands

`/start <token>` link wallet · `/status` linked wallets + HF + plan · `/unlink` remove all links · `/help`.
Pushes: `warning` (HF within 10% above trigger, max one per 30 min per address), `protected` (tx link + AI
digest, once per tx), `failed` (keeper protect reverted, max one per 30 min).
