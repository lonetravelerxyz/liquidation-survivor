# Architecture

```
 browser (dApp — Next.js app: wagmi + RainbowKit + TanStack Query; separate repo)
   │ connect OKX Wallet → read position → AI report → approve + enroll (user signs)
   │ /api/* and /m/api/* are rewritten by Next to the testnet / mainnet backend
   ▼
 express (src/server.ts)  ──  /api/*  ──  src/aave/* (viem reads)  ──  X Layer RPC
   │                                      src/ai/*   (Claude; rules fallback)
   │                                      src/db/*   (SQLite: plans, snapshots, protections, bindings, ai cache)
   ▼
 sentinel (src/sentinel/*)  every SENTINEL_INTERVAL_MS + on /hooks/quicknode:
   index Guard events → for each active plan read hf → snapshot → if hf < trigger: keeper.protect(user)
   → Telegram push (src/telegram/*) for: enrolled, warning (hf within 5% of trigger), protected, failed
   ▼
 SurvivalGuard.sol (contracts/) → Aave V3 Pool (mainnet) / MockPool (testnet)
```

Principles

- **Contract enforces, server recommends.** Every server decision is re-checked on-chain by `protect`.
- **Keeper key holds gas only.** It can only call `protect`, which can only repay the user's debt.
- **One process** (`src/index.ts` starts express + sentinel loop + Telegram). `pnpm sentinel` runs the loop alone.
- **SQLite is a cache/index** of chain state plus Telegram bindings and AI cache. Rebuildable from events.
- **AI degrades, never blocks.** `/api/explain` returns a rules-based report when the model fails.

Module map

| Path                   | Owns                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `src/config.ts`        | env → typed config; `CHAIN` selects mainnet/testnet addresses            |
| `src/chains/xlayer.ts` | chain defs, explorer URLs, reserve metadata                              |
| `src/aave/position.ts` | read account data, per-reserve balances, prices                          |
| `src/guard/`           | Guard ABI, read plan/preview, keeper write `protect`                     |
| `src/ai/`              | prompts + Claude call + rules fallback + cache                           |
| `src/sentinel/`        | loop, event indexer, decision, notifications                             |
| `src/telegram/`        | grammY bot, bind flow, message templates                                 |
| `src/routes/`          | express routers (`api.ts`, `hooks.ts`, `pages.ts`)                       |
| `src/views/`           | legacy vanilla pages served by express (superseded by the dApp)              |
| `src/db/`              | schema + migrations + typed queries                                      |
| `contracts/`           | Foundry: `SurvivalGuard.sol`, mocks, tests, deploy scripts               |
| `scripts/demo/`        | testnet sequence (deploy mocks → enroll → dip → protect)                 |

## Frontend

The product dApp (app.dark-survivor.com) and the marketing site (dark-survivor.com) are Next.js apps
maintained in a separate repository. They talk to this backend only over HTTP (`docs/api.md`); wallet
writes (approve / enroll / update / disable) go straight to the chain from the browser — the server
never holds user keys. ABIs are generated from `contracts/out`.
