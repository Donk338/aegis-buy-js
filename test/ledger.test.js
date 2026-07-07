import assert from "node:assert/strict";
import { test } from "node:test";

import { tmpLedger } from "./helpers.js";

test("record returns incrementing ids and persists rows", () => {
  const led = tmpLedger();
  assert.equal(led.record("https://a.example/x", 0.01, "paid", "0x1"), 1);
  assert.equal(led.record("https://a.example/y", 0.02, "blocked", null, { reason: "nope" }), 2);
  assert.equal(led.record("https://a.example/z", null, "failed"), 3);
});

test("daySpend / totalSpend count only 'paid' rows", () => {
  const led = tmpLedger();
  led.record("https://a.example/x", 0.30, "paid", "0xabc");
  led.record("https://a.example/x", 0.25, "paid");
  led.record("https://a.example/x", 9.99, "blocked");
  led.record("https://a.example/x", 9.99, "dry_run");
  led.record("https://a.example/x", 0.0, "free");
  led.record("https://a.example/x", 9.99, "failed");
  assert.ok(Math.abs(led.daySpend() - 0.55) < 1e-9);
  assert.ok(Math.abs(led.totalSpend() - 0.55) < 1e-9);
});

test("stats shape: counts by status, recent newest-first, path", () => {
  const led = tmpLedger();
  for (let i = 1; i <= 7; i++) led.record(`https://a.example/${i}`, 0.001 * i, i % 2 ? "paid" : "dry_run", `0x${i}`);
  const s = led.stats();
  assert.equal(s.purchases, 7);
  assert.deepEqual(s.by_status, { paid: 4, dry_run: 3 });
  assert.equal(s.recent.length, 5);
  assert.equal(s.recent[0].url, "https://a.example/7");
  assert.equal(s.recent[4].url, "https://a.example/3");
  assert.equal(typeof s.day_spend_usd, "number");
  assert.equal(typeof s.total_spend_usd, "number");
  assert.equal(s.ledger_path, led.path);
});
