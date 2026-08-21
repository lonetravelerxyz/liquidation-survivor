import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { isolateEnv } from "./helpers.js";

isolateEnv();
const { rulesExplain, rulesRecommend, rulesDigest, riskLevel, pickDebtAsset } =
  await import("../src/ai/rules.js");
const { explainPosition, recommendPlan, digestEvent } = await import("../src/ai/explain.js");
type PositionJson = import("../src/aave/position.js").PositionJson;

const position = (hf: number | null, debtUsd = 2000): PositionJson => ({
  address: "0x1111111111111111111111111111111111111111",
  chain: "testnet",
  healthFactor: hf,
  hf,
  totalCollateralUsd: 4800,
  collateralUsd: 4800,
  totalDebtUsd: debtUsd,
  debtUsd,
  liquidationThresholdBps: 7958,
  ltvBps: 7500,
  reserves: [
    {
      symbol: "xETH",
      address: "0xe7b000003a45145decf8a28fc755ad5ec5ea025a",
      decimals: 18,
      aToken: "0x0000000000000000000000000000000000000001",
      vToken: "0x0000000000000000000000000000000000000002",
      price: 1900,
      priceUsd: 1900,
      isStable: false,
      supplied: "2",
      borrowed: "0",
      suppliedUsd: 3800,
      borrowedUsd: 0,
      liquidationThresholdBps: 8000,
    },
    {
      symbol: "USDT",
      address: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      decimals: 6,
      aToken: "0x0000000000000000000000000000000000000003",
      vToken: "0x0000000000000000000000000000000000000004",
      price: 1,
      priceUsd: 1,
      isStable: true,
      supplied: "1000",
      borrowed: String(debtUsd),
      suppliedUsd: 1000,
      borrowedUsd: debtUsd,
      liquidationThresholdBps: 7800,
    },
  ],
  liquidationPriceHints: [
    { symbol: "xETH", currentPrice: 1900, liquidationPrice: 762.5, dropPct: 59.87 },
    { symbol: "USDT", currentPrice: 1, liquidationPrice: null, dropPct: null },
  ],
  fetchedAt: 0,
});

describe("rules fallback", () => {
  it("risk levels", () => {
    assert.equal(riskLevel(null), "safe");
    assert.equal(riskLevel(1.6), "safe");
    assert.equal(riskLevel(1.2), "watch");
    assert.equal(riskLevel(1.05), "danger");
  });
  it("explains a position with liquidation prices and penalty", () => {
    const e = rulesExplain(position(1.91));
    assert.equal(e.riskLevel, "safe");
    assert.match(e.summary, /1\.91/);
    assert.match(e.summary, /xETH/);
    assert.deepEqual(e.estimatedPenaltyUsd, { min: 100, max: 200 });
    assert.equal(e.liquidationPrices[0]?.price, 762.5);
    assert.ok(e.bullets.length >= 2);
  });
  it("handles no-debt accounts", () => {
    const e = rulesExplain(position(null, 0));
    assert.equal(e.riskLevel, "safe");
    assert.equal(e.estimatedPenaltyUsd, null);
    assert.match(e.summary, /no debt/);
  });
  it("recommends defaults with a buffer derived from trigger→target", () => {
    const r = rulesRecommend(position(1.91));
    assert.equal(r.triggerHF, 1.15);
    assert.equal(r.targetHF, 1.4);
    assert.equal(r.cooldown, 600);
    assert.equal(r.debtAssetSymbol, "USDT");
    assert.equal(r.debtAsset, "0x779ded0c9e1022225f8e0630b35a9b54be713736");
    assert.ok(r.maxRepayUsd <= 600 + 1e-9, "capped at 30% of debt");
    assert.ok(r.maxRepayUsd > 0);
    assert.ok(r.bufferUsd > 0);
    assert.ok(Number(r.maxRepayPerProtect) > 0);
    assert.ok(r.rationale.length >= 2);
  });
  it("caps by the wallet buffer when given", () => {
    const r = rulesRecommend(position(1.91), { bufferUsd: 50 });
    assert.equal(r.maxRepayUsd, 50);
  });
  it("picks the largest borrowed stablecoin", () => {
    assert.equal(pickDebtAsset(position(1.5))?.symbol, "USDT");
    assert.equal(pickDebtAsset(position(null, 0)), null);
  });
  it("digests events", () => {
    assert.match(rulesDigest({ kind: "warning", address: "0x1", hf: 1.2, triggerHf: 1.15 }).text, /1\.20/);
    assert.match(
      rulesDigest({
        kind: "protected",
        address: "0x1",
        debtAssetSymbol: "USDT",
        repaid: "100",
        fee: "0.1",
        hfBefore: 1.1,
        hfAfter: 1.4,
        txUrl: "",
      }).text,
      /100 USDT/,
    );
  });
});

describe("explain.ts without an AI key", () => {
  before(() => assert.equal(process.env.ANTHROPIC_API_KEY, ""));
  it("returns rules results tagged source=rules and caches them", async () => {
    const p = position(1.2);
    const e1 = await explainPosition(p, null);
    assert.equal(e1.source, "rules");
    assert.equal(e1.model, "rules");
    assert.equal(e1.riskLevel, "watch");
    const e2 = await explainPosition(p, null);
    assert.equal(e2.generatedAt, e1.generatedAt, "second call served from ai_cache");
    const r = await recommendPlan(p);
    assert.equal(r.source, "rules");
    assert.equal(r.triggerHF, 1.15);
    const d = await digestEvent({ kind: "warning", address: p.address, hf: 1.2, triggerHf: 1.15 });
    assert.equal(d.source, "rules");
    assert.ok(d.text.length > 10);
  });
});
