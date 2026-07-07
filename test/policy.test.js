import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { SpendPolicy, TIER_RANK } from "../src/policy.js";
import { tmpDir, tmpLedger } from "./helpers.js";

test("per-call cap", () => {
  const p = new SpendPolicy({ max_per_call_usd: 0.05 });
  assert.equal(p.check("https://api.example.com/x", 0.05, "trusted").allowed, true);
  const r = p.check("https://api.example.com/x", 0.06, "trusted");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /max_per_call/);
});

test("day cap from ledger — blocked and dry_run rows must not count", () => {
  const led = tmpLedger();
  led.record("https://a.example/x", 0.90, "paid", "0xabc");
  led.record("https://a.example/x", 0.50, "blocked");
  led.record("https://a.example/x", 0.50, "dry_run");
  const p = new SpendPolicy({ max_per_call_usd: 0.20, max_per_day_usd: 1.00, ledger: led });
  assert.equal(p.check("https://a.example/x", 0.05, "trusted").allowed, true);
  const r = p.check("https://a.example/x", 0.15, "trusted");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /max_per_day/);
});

test("total cap", () => {
  const led = tmpLedger();
  led.record("https://a.example/x", 0.04, "paid");
  const p = new SpendPolicy({ max_per_day_usd: 100, max_total_usd: 0.05, ledger: led });
  const r = p.check("https://a.example/x", 0.02, "trusted");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /max_total/);
});

test("tier ladder unverified<provisional<verified<trusted; flagged always blocked", () => {
  assert.deepEqual(TIER_RANK, { unverified: 0, provisional: 1, verified: 2, trusted: 3 });
  const p = new SpendPolicy({ min_tier: "provisional" });
  assert.equal(p.check("https://a.example/x", 0.01, "trusted").allowed, true);
  assert.equal(p.check("https://a.example/x", 0.01, "verified").allowed, true);
  assert.equal(p.check("https://a.example/x", 0.01, "provisional").allowed, true);
  const low = p.check("https://a.example/x", 0.01, "unverified");
  assert.equal(low.allowed, false);
  assert.match(low.reason, /tier/);
  const flagged = p.check("https://a.example/x", 0.01, "flagged");
  assert.equal(flagged.allowed, false);
  assert.match(flagged.reason, /FLAGGED/);
  // min_tier verified blocks provisional
  const pv = new SpendPolicy({ min_tier: "verified" });
  assert.equal(pv.check("https://a.example/x", 0.01, "provisional").allowed, false);
  assert.equal(pv.check("https://a.example/x", 0.01, "verified").allowed, true);
  // flagged blocks even with trust_mode off; off ignores low tiers
  const pOff = new SpendPolicy({ trust_mode: "off" });
  assert.equal(pOff.check("https://a.example/x", 0.01, "flagged").allowed, false);
  assert.equal(pOff.check("https://a.example/x", 0.01, "unverified").allowed, true);
});

test("deny and allow domain lists (subdomains match)", () => {
  const p = new SpendPolicy({ deny_domains: ["evil.example"], min_tier: "unverified" });
  const r = p.check("https://api.evil.example/x", 0.01, "trusted");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /deny/);
  const p2 = new SpendPolicy({ allow_domains: ["good.example"], min_tier: "unverified" });
  assert.equal(p2.check("https://good.example/x", 0.01, "trusted").allowed, true);
  assert.equal(p2.check("https://sub.good.example/x", 0.01, "trusted").allowed, true);
  assert.equal(p2.check("https://other.example/x", 0.01, "trusted").allowed, false);
});

test("unknown / bad prices blocked", () => {
  const p = new SpendPolicy();
  const r = p.check("https://a.example/x", null, "trusted");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /price unknown/);
  assert.equal(p.check("https://a.example/x", "not-a-number", "trusted").allowed, false);
  assert.equal(p.check("https://a.example/x", -0.01, "trusted").allowed, false);
  assert.equal(p.check("not a url", 0.01, "trusted").allowed, false);
});

test("load from JSON file with AEGIS_BUY_POLICY env override", () => {
  const dir = tmpDir();
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify({
    max_per_call_usd: 0.02, max_per_day_usd: 0.10, min_tier: "verified",
    deny_domains: ["bad.example"], trust_mode: "strict", junk_key: "ignored",
  }));
  const prev = process.env.AEGIS_BUY_POLICY;
  process.env.AEGIS_BUY_POLICY = file;
  try {
    const p = SpendPolicy.load();
    assert.equal(p.maxPerCallUsd, 0.02);
    assert.equal(p.maxPerDayUsd, 0.10);
    assert.equal(p.minTier, "verified");
    assert.deepEqual(p.denyDomains, ["bad.example"]);
    assert.equal(p.trustMode, "strict");
  } finally {
    if (prev === undefined) delete process.env.AEGIS_BUY_POLICY;
    else process.env.AEGIS_BUY_POLICY = prev;
  }
  // explicit path beats env; missing file -> safe defaults
  const p2 = SpendPolicy.load({ path: path.join(dir, "missing.json") });
  assert.equal(p2.maxPerCallUsd, 0.05);
  assert.equal(p2.maxPerDayUsd, 1.0);
  assert.equal(p2.minTier, "provisional");
  assert.equal(p2.trustMode, "basic");
});

test("invalid config throws", () => {
  assert.throws(() => new SpendPolicy({ min_tier: "vip" }), /min_tier/);
  assert.throws(() => new SpendPolicy({ trust_mode: "yolo" }), /trust_mode/);
});
