import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WARN_FACTOR,
  failedDedupeKey,
  protectedDedupeKey,
  shouldProtect,
  shouldWarn,
  shrinkChunk,
  warnDedupeKey,
} from "../src/sentinel/decision.js";

describe("shouldWarn", () => {
  it("warns within 10% above the trigger", () => {
    assert.equal(shouldWarn({ hf: 1.2, triggerHf: 1.15, active: true }), true);
    assert.equal(shouldWarn({ hf: 1.15 * WARN_FACTOR - 0.001, triggerHf: 1.15, active: true }), true);
  });
  it("does not warn when comfortably above, inactive, or without debt", () => {
    assert.equal(shouldWarn({ hf: 1.3, triggerHf: 1.15, active: true }), false);
    assert.equal(shouldWarn({ hf: 1.1, triggerHf: 1.15, active: false }), false);
    assert.equal(shouldWarn({ hf: Infinity, triggerHf: 1.15, active: true }), false);
    assert.equal(shouldWarn({ hf: 0, triggerHf: 1.15, active: true }), false);
  });
  it("still warns when already below the trigger", () => {
    assert.equal(shouldWarn({ hf: 1.05, triggerHf: 1.15, active: true }), true);
  });
});

describe("shouldProtect", () => {
  it("requires eligible + keeper + not paused + amount", () => {
    assert.equal(
      shouldProtect({ eligible: true, keeperEnabled: true, paused: false, repayAmount: 1n }),
      true,
    );
    assert.equal(
      shouldProtect({ eligible: false, keeperEnabled: true, paused: false, repayAmount: 1n }),
      false,
    );
    assert.equal(
      shouldProtect({ eligible: true, keeperEnabled: false, paused: false, repayAmount: 1n }),
      false,
    );
    assert.equal(
      shouldProtect({ eligible: true, keeperEnabled: true, paused: true, repayAmount: 1n }),
      false,
    );
    assert.equal(
      shouldProtect({ eligible: true, keeperEnabled: true, paused: false, repayAmount: 0n }),
      false,
    );
  });
});

describe("dedupe keys", () => {
  it("warning keys share a 30-minute bucket and are case-insensitive", () => {
    const a = warnDedupeKey("0xABC", 1000);
    assert.equal(a, warnDedupeKey("0xabc", 1700));
    assert.notEqual(a, warnDedupeKey("0xabc", 1000 + 30 * 60));
    assert.notEqual(failedDedupeKey("0xabc", 1000), a);
  });
  it("protected keys are per tx hash", () => {
    assert.equal(protectedDedupeKey("0xAB"), protectedDedupeKey("0xab"));
    assert.notEqual(protectedDedupeKey("0x01"), protectedDedupeKey("0x02"));
  });
  it("shrinkChunk halves down to the floor", () => {
    assert.equal(shrinkChunk(2000), 1000);
    assert.equal(shrinkChunk(150), 100);
    assert.equal(shrinkChunk(100), 100);
  });
});
