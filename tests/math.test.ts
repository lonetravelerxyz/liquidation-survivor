import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_UINT256,
  formatUnitsStr,
  hfAfterRepay,
  hfForJson,
  hfToNumber,
  liquidationPrices,
  parseUnitsStr,
  repayUsdToReach,
  tokenUsd,
} from "../src/aave/math.js";

describe("hf conversions", () => {
  it("max uint → Infinity → null in JSON", () => {
    assert.equal(hfToNumber(MAX_UINT256), Infinity);
    assert.equal(hfForJson(Infinity), null);
    assert.equal(hfToNumber(1_150_000_000_000_000_000n), 1.15);
    assert.equal(hfForJson(1.23456789), 1.2346);
  });
});

describe("units", () => {
  it("formats and parses token units", () => {
    assert.equal(formatUnitsStr(1_500_000n, 6), "1.5");
    assert.equal(formatUnitsStr(0n, 18), "0");
    assert.equal(formatUnitsStr(10n ** 18n + 5n, 18), "1.000000000000000005");
    assert.equal(parseUnitsStr("1.5", 6), 1_500_000n);
    assert.equal(parseUnitsStr("0.1234567", 6), 123_456n);
    assert.equal(tokenUsd(2n * 10n ** 18n, 18, 1900_00000000n), 3800);
  });
});

describe("liquidation maths", () => {
  // 2 xETH @ 1900 (LT 80%) + 1000 USDT (LT 78%), debt 2000 USDT
  const legs = [
    { symbol: "xETH", suppliedUsd: 3800, priceUsd: 1900, liquidationThresholdBps: 8000 },
    { symbol: "USDT", suppliedUsd: 1000, priceUsd: 1, liquidationThresholdBps: 7800 },
  ];
  it("computes the price where hf crosses 1 for a single moving asset", () => {
    const hints = liquidationPrices(legs, 2000, 7958);
    const eth = hints.find((h) => h.symbol === "xETH")!;
    // p = 1900 * (2000 - 780) / (3800 * 0.8) = 1900 * 0.40131... = 762.5
    assert.ok(Math.abs(eth.liquidationPrice! - 762.5) < 0.01, String(eth.liquidationPrice));
    assert.ok(Math.abs(eth.dropPct! - 59.87) < 0.05);
    const usdt = hints.find((h) => h.symbol === "USDT")!;
    // other collateral (3040) alone covers the 2000 debt → no single-asset liquidation price
    assert.equal(usdt.liquidationPrice, null);
  });
  it("returns nulls when there is no debt", () => {
    const hints = liquidationPrices(legs, 0, 8000);
    assert.equal(hints.length, 2);
    assert.ok(hints.every((h) => h.liquidationPrice === null && h.dropPct === null));
  });
  it("repay-to-target mirrors the contract formula", () => {
    // c=4800, lt=79.58%, d=2000 → hf=1.91; target 2.5 → debtTarget = 4800*0.7958/2.5 = 1527.9 → repay 472.1
    const r = repayUsdToReach(4800, 2000, 7958, 2.5);
    assert.ok(Math.abs(r - 472.06) < 0.1, String(r));
    assert.equal(repayUsdToReach(4800, 2000, 7958, 1.5), 0);
    assert.ok(Math.abs(hfAfterRepay(4800, 2000, 7958, 472.06) - 2.5) < 0.001);
    assert.equal(hfAfterRepay(4800, 2000, 7958, 2000), Infinity);
  });
});
