export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plans (
  address TEXT PRIMARY KEY,
  debt_asset TEXT NOT NULL,
  trigger_hf TEXT NOT NULL,        -- 1e18-scaled decimal string
  target_hf TEXT NOT NULL,
  max_repay TEXT NOT NULL,         -- token units decimal string
  cooldown INTEGER NOT NULL,
  active INTEGER NOT NULL,
  updated_block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  hf TEXT NOT NULL,
  collateral_usd REAL NOT NULL,
  debt_usd REAL NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_addr_ts ON snapshots(address, ts);
CREATE TABLE IF NOT EXISTS protections (
  tx_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  debt_asset TEXT NOT NULL,
  repaid TEXT NOT NULL,
  fee TEXT NOT NULL,
  hf_before TEXT NOT NULL,
  hf_after TEXT NOT NULL,
  keeper TEXT NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS protections_addr_ts ON protections(address, ts);
CREATE TABLE IF NOT EXISTS telegram_bindings (
  address TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (address, chat_id)
);
CREATE INDEX IF NOT EXISTS telegram_bindings_chat ON telegram_bindings(chat_id);
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  token TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sentinel_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  kind TEXT NOT NULL,              -- enrolled | warning | protected | failed
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`;
