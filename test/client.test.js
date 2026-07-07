import assert from "node:assert/strict";
import { test } from "node:test";

import { BuyClient, decodePaymentRequired, parsePriceUsd, appendParams } from "../src/client.js";
import { SpendPolicy } from "../src/policy.js";
import { fakeRes, prHeader, tmpLedger } from "./helpers.js";

const NET = "eip155:8453";

function mkClient({ policy = {}, dryRun = true, httpGet, payFetch = null } = {}) {
  const ledger = tmpLedger();
  return new BuyClient({
    dryRun,
    ledger,
    policy: new SpendPolicy({ trust_mode: "off", ...policy, ledger }),
    httpGet,
    payFetch,
  });
}

// ---- pure helpers ----

test("decodePaymentRequired handles unpadded base64", () => {
  const pr = decodePaymentRequired(prHeader(12345));
  assert.equal(pr.accepts[0].amount, "12345");
});

test("parsePriceUsd prefers our network, falls back to any, null when empty", () => {
  const pr = { accepts: [
    { network: "eip155:1", amount: "1000" },
    { network: NET, amount: "20000" },
    { network: NET, maxAmountRequired: "30000" },
  ] };
  assert.equal(parsePriceUsd(pr, NET), 0.02);          // min of OUR network only
  assert.equal(parsePriceUsd({ accepts: [{ network: "eip155:1", amount: "1000" }] }, NET), 0.001);
  assert.equal(parsePriceUsd({ accepts: [] }, NET), null);
  assert.equal(parsePriceUsd({ accepts: [{ network: NET, amount: "abc" }] }, NET), null);
});

test("appendParams merges query params and skips nulls", () => {
  assert.equal(appendParams("https://a.example/x?a=1", { b: 2, c: null }),
               "https://a.example/x?a=1&b=2");
  assert.equal(appendParams("https://a.example/x", null), "https://a.example/x");
});

// ---- get() flows (all network mocked) ----

test("free 200 resource: no payment, ledgered as free", async () => {
  const c = mkClient({ httpGet: async () => fakeRes({ status: 200, json: { hello: "world" } }) });
  const r = await c.get("https://api.example.com/free");
  assert.equal(r.ok, true);
  assert.equal(r.priceUsd, 0);
  assert.equal(r.reason, "free");
  assert.deepEqual(r.data, { hello: "world" });
  assert.deepEqual(c.stats().by_status, { free: 1 });
});

test("non-402 status is refused", async () => {
  const c = mkClient({ httpGet: async () => fakeRes({ status: 500, text: "oops" }) });
  const r = await c.get("https://api.example.com/broken");
  assert.equal(r.ok, false);
  assert.match(r.reason, /expected 402, got 500/);
});

test("probe network error is refused, never pays", async () => {
  const c = mkClient({ httpGet: async () => { throw new Error("ECONNREFUSED"); } });
  const r = await c.get("https://api.example.com/x");
  assert.equal(r.ok, false);
  assert.match(r.reason, /probe failed/);
});

test("dry-run flow: 402 -> price parsed -> allowed -> no payment, ledgered dry_run", async () => {
  const c = mkClient({
    httpGet: async () => fakeRes({ status: 402, headers: { "payment-required": prHeader(10000) } }),
  });
  const r = await c.get("https://api.example.com/paid", { symbol: "ETH" });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "dry_run");
  assert.equal(r.priceUsd, 0.01);
  assert.equal(r.wouldPay, 0.01);
  assert.deepEqual(r.receipt, { would_pay: 0.01 });
  assert.deepEqual(c.stats().by_status, { dry_run: 1 });
  assert.equal(c.ledger.daySpend(), 0); // dry runs never count as spend
});

test("price over max_per_call_usd is blocked before payment", async () => {
  const c = mkClient({
    httpGet: async () => fakeRes({ status: 402, headers: { "payment-required": prHeader(60000) } }),
  });
  const r = await c.get("https://api.example.com/pricey");
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.match(r.reason, /max_per_call_usd/);
  assert.deepEqual(c.stats().by_status, { blocked: 1 });
});

test("missing/unparseable price is blocked — never pay blind", async () => {
  const c = mkClient({ httpGet: async () => fakeRes({ status: 402, text: "pay me" }) });
  const r = await c.get("https://api.example.com/mystery");
  assert.equal(r.blocked, true);
  assert.match(r.reason, /price unknown/);
});

test("402 body fallback when header is absent", async () => {
  const c = mkClient({
    httpGet: async () => fakeRes({ status: 402, json: { accepts: [{ network: NET, amount: "5000" }] } }),
  });
  const r = await c.get("https://api.example.com/bodypr");
  assert.equal(r.priceUsd, 0.005);
  assert.equal(r.reason, "dry_run");
});

test("trust gate wired into get(): low tier blocks, tier attached to result", async () => {
  const ledger = tmpLedger();
  const c = new BuyClient({
    dryRun: true,
    ledger,
    policy: new SpendPolicy({ min_tier: "provisional", trust_mode: "basic", ledger }),
    httpGet: async (url) => {
      if (url.startsWith("https://aegis.borisinc.com/discover")) {
        return fakeRes({ json: { results: [{ url: "https://api.example.com", tier: "unverified" }] } });
      }
      if (url.startsWith("https://aegis.borisinc.com/registry.json")) {
        return fakeRes({ json: { services: [] } });
      }
      return fakeRes({ status: 402, headers: { "payment-required": prHeader(10000) } });
    },
  });
  const r = await c.get("https://api.example.com/paid");
  assert.equal(r.blocked, true);
  assert.match(r.reason, /tier 'unverified' below min_tier 'provisional'/);
  assert.equal(r.trust.tier, "unverified");
});

test("flagged service is always blocked even with trust_mode off... via explicit tier", () => {
  const p = new SpendPolicy({ trust_mode: "off" });
  assert.equal(p.check("https://bad.example/x", 0.01, "flagged").allowed, false);
});

test("paid flow with mocked payFetch: settles, captures tx + Aegis receipt, ledgered", async () => {
  let paidUrl = null;
  const c = mkClient({
    dryRun: false,
    httpGet: async () => fakeRes({ status: 402, headers: { "payment-required": prHeader(10000) } }),
    payFetch: async (url) => {
      paidUrl = url;
      return fakeRes({
        status: 200,
        json: { result: 42, receipt: { id: "rcpt_1", delivered: true } },
        headers: { "payment-response": "eyJ0eCI6IjB4ZGVhZGJlZWYifQ" },
      });
    },
  });
  const r = await c.get("https://api.example.com/paid");
  assert.equal(r.ok, true);
  assert.equal(r.reason, "paid");
  assert.equal(r.priceUsd, 0.01);
  assert.equal(r.tx, "eyJ0eCI6IjB4ZGVhZGJlZWYifQ");
  assert.deepEqual(r.receipt, { id: "rcpt_1", delivered: true });
  assert.equal(paidUrl, "https://api.example.com/paid");
  assert.deepEqual(c.stats().by_status, { paid: 1 });
  assert.ok(Math.abs(c.ledger.daySpend() - 0.01) < 1e-12);
});

test("failed payment is ledgered as failed, not paid", async () => {
  const c = mkClient({
    dryRun: false,
    httpGet: async () => fakeRes({ status: 402, headers: { "payment-required": prHeader(10000) } }),
    payFetch: async () => fakeRes({ status: 402, text: "settle failed" }),
  });
  const r = await c.get("https://api.example.com/paid");
  assert.equal(r.ok, false);
  assert.match(r.reason, /payment fetch failed/);
  assert.deepEqual(c.stats().by_status, { failed: 1 });
  assert.equal(c.ledger.daySpend(), 0);
});

test("day cap accumulates across purchases and then blocks", async () => {
  const ledger = tmpLedger();
  ledger.record("https://api.example.com/old", 0.98, "paid", "0x1");
  const c = new BuyClient({
    dryRun: true,
    ledger,
    policy: new SpendPolicy({ trust_mode: "off", max_per_day_usd: 1.0, ledger }),
    httpGet: async () => fakeRes({ status: 402, headers: { "payment-required": prHeader(30000) } }),
  });
  const r = await c.get("https://api.example.com/paid");
  assert.equal(r.blocked, true);
  assert.match(r.reason, /max_per_day_usd/);
});

// ---- procure ----

test("procure: budget over policy cap is blocked with zero network calls", async () => {
  let calls = 0;
  const c = mkClient({ httpGet: async () => { calls++; return fakeRes({ status: 402 }); } });
  const r = await c.procure("live ETH price", 10);
  assert.equal(r.blocked, true);
  assert.match(r.reason, /exceeds policy max_per_call_usd/);
  assert.equal(calls, 0);
  const bad = await c.procure("x", "lots");
  assert.equal(bad.blocked, true);
  assert.match(bad.reason, /bad budget/);
});

test("procure: within budget hits hub /procure with need+budget params (dry run)", async () => {
  let seenUrl = null;
  const c = mkClient({
    httpGet: async (url) => {
      seenUrl = url;
      return fakeRes({ status: 402, headers: { "payment-required": prHeader(10000) } });
    },
  });
  const r = await c.procure("live ETH price", 0.01);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "dry_run");
  const u = new URL(seenUrl);
  assert.equal(u.origin + u.pathname, "https://aegis.borisinc.com/procure");
  assert.equal(u.searchParams.get("need"), "live ETH price");
  assert.equal(u.searchParams.get("budget"), "0.01");
});
