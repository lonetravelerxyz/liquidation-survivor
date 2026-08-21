import { db } from "./index.js";

// ---------------------------------------------------------------- types (rows as stored)
export interface PlanRow {
  address: string;
  debt_asset: string;
  trigger_hf: string;
  target_hf: string;
  max_repay: string;
  cooldown: number;
  active: number;
  updated_block: number;
  updated_at: number;
}
export interface SnapshotRow {
  id: number;
  address: string;
  hf: string;
  collateral_usd: number;
  debt_usd: number;
  ts: number;
}
export interface ProtectionRow {
  tx_hash: string;
  address: string;
  debt_asset: string;
  repaid: string;
  fee: string;
  hf_before: string;
  hf_after: string;
  keeper: string;
  block: number;
  ts: number;
}
export interface BindingRow {
  address: string;
  chat_id: string;
  created_at: number;
}
export interface LinkTokenRow {
  token: string;
  address: string;
  expires_at: number;
  used: number;
}
export interface NotificationRow {
  id: number;
  address: string;
  kind: string;
  dedupe_key: string;
  payload_json: string;
  sent: number;
  created_at: number;
}

const now = () => Math.floor(Date.now() / 1000);
const lc = (a: string) => a.toLowerCase();

// ---------------------------------------------------------------- plans
const upsertPlanStmt = db.prepare(`
  INSERT INTO plans (address, debt_asset, trigger_hf, target_hf, max_repay, cooldown, active, updated_block, updated_at)
  VALUES (@address, @debt_asset, @trigger_hf, @target_hf, @max_repay, @cooldown, @active, @updated_block, @updated_at)
  ON CONFLICT(address) DO UPDATE SET
    debt_asset = excluded.debt_asset, trigger_hf = excluded.trigger_hf, target_hf = excluded.target_hf,
    max_repay = excluded.max_repay, cooldown = excluded.cooldown, active = excluded.active,
    updated_block = excluded.updated_block, updated_at = excluded.updated_at
  WHERE excluded.updated_block >= plans.updated_block`);
const setPlanActiveStmt = db.prepare(
  `UPDATE plans SET active = @active, updated_block = @block, updated_at = @ts WHERE address = @address AND updated_block <= @block`,
);
const getPlanStmt = db.prepare(`SELECT * FROM plans WHERE address = ?`);
const activePlansStmt = db.prepare(`SELECT * FROM plans WHERE active = 1 ORDER BY updated_at DESC`);
const countActivePlansStmt = db.prepare(`SELECT count(*) AS n FROM plans WHERE active = 1`);

export const plans = {
  upsert(p: Omit<PlanRow, "updated_at"> & { updated_at?: number }) {
    upsertPlanStmt.run({
      ...p,
      address: lc(p.address),
      debt_asset: lc(p.debt_asset),
      updated_at: p.updated_at ?? now(),
    });
  },
  setActive(address: string, active: boolean, block: number) {
    setPlanActiveStmt.run({ address: lc(address), active: active ? 1 : 0, block, ts: now() });
  },
  get: (address: string) => getPlanStmt.get(lc(address)) as PlanRow | undefined,
  active: () => activePlansStmt.all() as PlanRow[],
  countActive: () => (countActivePlansStmt.get() as { n: number }).n,
};

// ---------------------------------------------------------------- snapshots
const insertSnapshotStmt = db.prepare(
  `INSERT INTO snapshots (address, hf, collateral_usd, debt_usd, ts) VALUES (?, ?, ?, ?, ?)`,
);
const recentSnapshotsStmt = db.prepare(`SELECT * FROM snapshots WHERE address = ? ORDER BY ts DESC LIMIT ?`);
const lastSnapshotStmt = db.prepare(`SELECT * FROM snapshots WHERE address = ? ORDER BY ts DESC LIMIT 1`);
const pruneSnapshotsStmt = db.prepare(`DELETE FROM snapshots WHERE ts < ?`);

export const snapshots = {
  insert(address: string, hf: string, collateralUsd: number, debtUsd: number, ts = now()) {
    insertSnapshotStmt.run(lc(address), hf, collateralUsd, debtUsd, ts);
  },
  recent: (address: string, limit = 200) => recentSnapshotsStmt.all(lc(address), limit) as SnapshotRow[],
  last: (address: string) => lastSnapshotStmt.get(lc(address)) as SnapshotRow | undefined,
  pruneOlderThan: (ts: number) => pruneSnapshotsStmt.run(ts).changes,
};

// ---------------------------------------------------------------- protections
const insertProtectionStmt = db.prepare(`
  INSERT OR IGNORE INTO protections (tx_hash, address, debt_asset, repaid, fee, hf_before, hf_after, keeper, block, ts)
  VALUES (@tx_hash, @address, @debt_asset, @repaid, @fee, @hf_before, @hf_after, @keeper, @block, @ts)`);
const protectionsForStmt = db.prepare(`SELECT * FROM protections WHERE address = ? ORDER BY ts DESC LIMIT ?`);
const recentProtectionsStmt = db.prepare(`SELECT * FROM protections ORDER BY ts DESC LIMIT ?`);
const countProtectionsStmt = db.prepare(`SELECT count(*) AS n FROM protections`);
const repaidByAssetStmt = db.prepare(
  `SELECT debt_asset, count(*) AS n, CAST(SUM(CAST(repaid AS REAL)) AS TEXT) AS total FROM protections GROUP BY debt_asset`,
);
const perAddressStatsStmt = db.prepare(`
  SELECT p.address, count(*) AS protections, max(p.ts) AS last_ts,
         (SELECT hf FROM snapshots s WHERE s.address = p.address ORDER BY s.ts DESC LIMIT 1) AS last_hf
  FROM protections p GROUP BY p.address ORDER BY last_ts DESC LIMIT ?`);
const enrolledStatsStmt = db.prepare(`
  SELECT pl.address,
         (SELECT count(*) FROM protections pr WHERE pr.address = pl.address) AS protections,
         (SELECT hf FROM snapshots s WHERE s.address = pl.address ORDER BY s.ts DESC LIMIT 1) AS last_hf
  FROM plans pl WHERE pl.active = 1 ORDER BY pl.updated_at DESC LIMIT ?`);

export const protections = {
  /** returns true when the row was new */
  insert(p: ProtectionRow): boolean {
    return (
      insertProtectionStmt.run({
        ...p,
        tx_hash: lc(p.tx_hash),
        address: lc(p.address),
        debt_asset: lc(p.debt_asset),
        keeper: lc(p.keeper),
      }).changes > 0
    );
  },
  forAddress: (address: string, limit = 100) => protectionsForStmt.all(lc(address), limit) as ProtectionRow[],
  recent: (limit = 20) => recentProtectionsStmt.all(limit) as ProtectionRow[],
  count: () => (countProtectionsStmt.get() as { n: number }).n,
  repaidByAsset: () => repaidByAssetStmt.all() as { debt_asset: string; n: number; total: string | null }[],
  perAddress: (limit = 50) =>
    perAddressStatsStmt.all(limit) as {
      address: string;
      protections: number;
      last_ts: number;
      last_hf: string | null;
    }[],
  enrolled: (limit = 50) =>
    enrolledStatsStmt.all(limit) as { address: string; protections: number; last_hf: string | null }[],
};

// ---------------------------------------------------------------- telegram
const insertBindingStmt = db.prepare(
  `INSERT OR IGNORE INTO telegram_bindings (address, chat_id, created_at) VALUES (?, ?, ?)`,
);
const bindingsForAddressStmt = db.prepare(`SELECT * FROM telegram_bindings WHERE address = ?`);
const bindingsForChatStmt = db.prepare(
  `SELECT * FROM telegram_bindings WHERE chat_id = ? ORDER BY created_at`,
);
const deleteBindingsForChatStmt = db.prepare(`DELETE FROM telegram_bindings WHERE chat_id = ?`);
const deleteBindingStmt = db.prepare(`DELETE FROM telegram_bindings WHERE chat_id = ? AND address = ?`);
const insertTokenStmt = db.prepare(
  `INSERT INTO telegram_link_tokens (token, address, expires_at, used) VALUES (?, ?, ?, 0)`,
);
const getTokenStmt = db.prepare(`SELECT * FROM telegram_link_tokens WHERE token = ?`);
const useTokenStmt = db.prepare(`UPDATE telegram_link_tokens SET used = 1 WHERE token = ? AND used = 0`);
const pruneTokensStmt = db.prepare(`DELETE FROM telegram_link_tokens WHERE expires_at < ? OR used = 1`);

export const telegram = {
  bind(address: string, chatId: string | number) {
    insertBindingStmt.run(lc(address), String(chatId), now());
  },
  bindingsForAddress: (address: string) => bindingsForAddressStmt.all(lc(address)) as BindingRow[],
  bindingsForChat: (chatId: string | number) => bindingsForChatStmt.all(String(chatId)) as BindingRow[],
  unbindChat: (chatId: string | number) => deleteBindingsForChatStmt.run(String(chatId)).changes,
  unbind: (chatId: string | number, address: string) =>
    deleteBindingStmt.run(String(chatId), lc(address)).changes,
  createLinkToken(token: string, address: string, ttlSeconds = 15 * 60) {
    insertTokenStmt.run(token, lc(address), now() + ttlSeconds);
  },
  /** Consumes the token; returns the bound address or null when unknown/expired/used. */
  consumeLinkToken(token: string): string | null {
    const row = getTokenStmt.get(token) as LinkTokenRow | undefined;
    if (!row || row.used || row.expires_at < now()) return null;
    useTokenStmt.run(token);
    return row.address;
  },
  pruneTokens: () => pruneTokensStmt.run(now()).changes,
};

// ---------------------------------------------------------------- ai cache
const getCacheStmt = db.prepare(`SELECT payload_json, created_at FROM ai_cache WHERE cache_key = ?`);
const putCacheStmt = db.prepare(
  `INSERT INTO ai_cache (cache_key, payload_json, created_at) VALUES (?, ?, ?)
   ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, created_at = excluded.created_at`,
);
const pruneCacheStmt = db.prepare(`DELETE FROM ai_cache WHERE created_at < ?`);

export const aiCache = {
  get<T>(key: string, ttlSeconds: number): T | null {
    const row = getCacheStmt.get(key) as { payload_json: string; created_at: number } | undefined;
    if (!row || row.created_at + ttlSeconds < now()) return null;
    try {
      return JSON.parse(row.payload_json) as T;
    } catch {
      return null;
    }
  },
  put(key: string, value: unknown) {
    putCacheStmt.run(key, JSON.stringify(value), now());
  },
  prune: (olderThanSeconds: number) => pruneCacheStmt.run(now() - olderThanSeconds).changes,
};

// ---------------------------------------------------------------- sentinel state (kv)
const getStateStmt = db.prepare(`SELECT value FROM sentinel_state WHERE key = ?`);
const setStateStmt = db.prepare(
  `INSERT INTO sentinel_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);

export const state = {
  get: (key: string): string | null =>
    (getStateStmt.get(key) as { value: string } | undefined)?.value ?? null,
  set: (key: string, value: string | number | bigint) => setStateStmt.run(key, String(value)),
  getInt(key: string): number | null {
    const v = this.get(key);
    return v === null ? null : Number(v);
  },
};

// ---------------------------------------------------------------- notifications (dedupe log)
const insertNotificationStmt = db.prepare(`
  INSERT OR IGNORE INTO notifications (address, kind, dedupe_key, payload_json, sent, created_at)
  VALUES (?, ?, ?, ?, 0, ?)`);
const markSentStmt = db.prepare(`UPDATE notifications SET sent = 1 WHERE dedupe_key = ?`);
const lastOfKindStmt = db.prepare(
  `SELECT * FROM notifications WHERE address = ? AND kind = ? ORDER BY created_at DESC LIMIT 1`,
);
const recentNotificationsStmt = db.prepare(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`);

export const notifications = {
  /** Returns true when the dedupe key was new (caller should send). */
  claim(address: string, kind: string, dedupeKey: string, payload: unknown): boolean {
    return (
      insertNotificationStmt.run(lc(address), kind, dedupeKey, JSON.stringify(payload), now()).changes > 0
    );
  },
  markSent: (dedupeKey: string) => markSentStmt.run(dedupeKey),
  lastOfKind: (address: string, kind: string) =>
    lastOfKindStmt.get(lc(address), kind) as NotificationRow | undefined,
  recent: (limit = 50) => recentNotificationsStmt.all(limit) as NotificationRow[],
};
