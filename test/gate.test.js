import assert from "node:assert/strict";
import { test } from "node:test";

import { TrustGate } from "../src/gate.js";
import { fakeRes } from "./helpers.js";

const HUB = "https://aegis.borisinc.com";

test("basic mode: match from /discover free signals", async () => {
  const calls = [];
  const gate = new TrustGate({
    mode: "basic",
    httpGet: async (url, params) => {
      calls.push([url, params]);
      if (url === `${HUB}/discover`) {
        return fakeRes({ json: { results: [
          { url: "https://api.example.com", tier: "trusted", trust_score: 97, name: "Example API" },
        ] } });
      }
      throw new Error("unexpected url " + url);
    },
  });
  const info = await gate.check("https://api.example.com/data?x=1");
  assert.equal(info.tier, "trusted");
  assert.equal(info.trust_score, 97);
  assert.equal(info.source, "aegis-free-signals");
  assert.deepEqual(calls[0], [`${HUB}/discover`, { query: "api.example.com" }]);
});

test("basic mode: falls back to /registry.json when discover fails", async () => {
  const gate = new TrustGate({
    mode: "basic",
    httpGet: async (url) => {
      if (url === `${HUB}/discover`) throw new Error("boom");
      if (url === `${HUB}/registry.json`) {
        return fakeRes({ json: { services: [
          { url: "https://api.example.com", tier: "provisional", trust_score: 60 },
        ] } });
      }
      throw new Error("unexpected url " + url);
    },
  });
  const info = await gate.check("https://api.example.com/data");
  assert.equal(info.tier, "provisional");
  assert.equal(info.source, "aegis-free-signals");
});

test("unknown service -> unverified, never throws", async () => {
  const gate = new TrustGate({ mode: "basic", httpGet: async () => { throw new Error("net down"); } });
  const info = await gate.check("https://nobody.example/x");
  assert.equal(info.tier, "unverified");
  assert.equal(info.source, "unknown-to-aegis");
  assert.equal((await gate.check("not a url")).source, "bad-url");
});

test("10-minute cache: second check does not re-fetch", async () => {
  let n = 0;
  const gate = new TrustGate({
    mode: "basic",
    httpGet: async (url) => {
      n++;
      return fakeRes({ json: { results: [{ url: "https://api.example.com", tier: "verified" }] } });
    },
  });
  await gate.check("https://api.example.com/a");
  const before = n;
  const info = await gate.check("https://api.example.com/b");
  assert.equal(n, before); // served from cache
  assert.equal(info.tier, "verified");
});

test("off mode skips everything", async () => {
  const gate = new TrustGate({ mode: "off", httpGet: async () => { throw new Error("must not be called"); } });
  assert.deepEqual(await gate.check("https://api.example.com/x"),
                   { tier: null, trust_score: null, source: "off" });
});

test("strict mode: paid /trust via payGet; unavailable without payment client", async () => {
  const seen = [];
  const gate = new TrustGate({
    mode: "strict",
    payGet: async (url, params) => {
      seen.push([url, params]);
      return { ok: true, data: { tier: "verified", trust_score: 88, recommendation: "ok to buy" } };
    },
    httpGet: async () => { throw new Error("basic path must not be used in strict"); },
  });
  const info = await gate.check("https://api.example.com/x");
  assert.equal(info.tier, "verified");
  assert.equal(info.trust_score, 88);
  assert.equal(info.source, "aegis-paid-trust-check");
  assert.deepEqual(seen[0], [`${HUB}/trust`, { url: "https://api.example.com/x" }]);

  const bare = new TrustGate({ mode: "strict" });
  const miss = await bare.check("https://api.example.com/x");
  assert.equal(miss.tier, "unverified");
  assert.match(miss.source, /strict-unavailable/);
});

test("strict mode: blocked/failed pay result degrades to unverified", async () => {
  const gate = new TrustGate({
    mode: "strict",
    payGet: async () => ({ ok: false, blocked: true, reason: "over cap" }),
  });
  const info = await gate.check("https://api.example.com/x");
  assert.equal(info.tier, "unverified");
  assert.match(info.source, /strict-check-failed \(over cap\)/);
});
