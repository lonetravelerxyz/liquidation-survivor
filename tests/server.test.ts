import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { isolateEnv } from "./helpers.js";

isolateEnv({ CHAIN: "testnet", GUARD_ADDRESS_TESTNET: "", POOL_ADDRESS_TESTNET: "" });
const { createApp } = await import("../src/server.js");

let server: Server;
let base = "";

describe("server smoke (testnet, no addresses configured)", () => {
  before(async () => {
    const app = createApp({ telegram: false });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  after(() => server.close());

  it("GET /healthz", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; chain: string };
    assert.equal(body.ok, true);
    assert.equal(body.chain, "testnet");
  });

  it("GET /api/config returns 200 with guardAddress null", async () => {
    const res = await fetch(`${base}/api/config`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.chainId, 1952);
    assert.equal(body.guardAddress, null);
    assert.equal(body.guard, null);
    assert.equal(body.poolAddress, null);
    assert.deepEqual(body.reserves, []);
    assert.equal(body.aiEnabled, false);
    assert.ok(Array.isArray(body.guardAbi));
    assert.equal(body.telegramBotUsername, null);
  });

  it("GET /api/board returns zeros", async () => {
    const res = await fetch(`${base}/api/board`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.enrolled, 0);
    assert.equal(body.protections, 0);
    assert.equal(body.repaidUsd, 0);
  });

  it("GET /api/history/:address returns empty history; bad address → 400", async () => {
    const ok = await fetch(`${base}/api/history/0x1111111111111111111111111111111111111111`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { protections: unknown[]; snapshots: unknown[] };
    assert.deepEqual(body.protections, []);
    assert.deepEqual(body.snapshots, []);
    const bad = await fetch(`${base}/api/history/nope`);
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, "invalid address");
  });

  it("GET /api/position without a pool → 503 JSON error", async () => {
    const res = await fetch(`${base}/api/position/0x1111111111111111111111111111111111111111`);
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { error: string }).error, /pool/);
  });

  it("POST /api/explain validates the body", async () => {
    const res = await fetch(`${base}/api/explain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "bad" }),
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/telegram/link → 503 when bot not configured", async () => {
    const res = await fetch(`${base}/api/telegram/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "0x1111111111111111111111111111111111111111" }),
    });
    assert.equal(res.status, 503);
  });

  it("POST /hooks/quicknode → 503 without a token configured", async () => {
    const res = await fetch(`${base}/hooks/quicknode`, { method: "POST" });
    assert.equal(res.status, 503);
  });

  it("unknown /api route → JSON 404", async () => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.ok(((await res.json()) as { error: string }).error);
  });
});
