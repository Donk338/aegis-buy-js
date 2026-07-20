import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClient, paidGet, procure, asText, getAegisTools } from "../src/frameworks.js";

const KEYS = ["AEGIS_BUYER_KEY", "X402_PRIVATE_KEY", "AEGIS_BUY_KEY"];
const saved = {};
for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }

test("no key -> makeClient null", () => {
  assert.equal(makeClient(), null);
});

test("no key -> paidGet instructive error, no throw, no spend", async () => {
  const r = await paidGet("https://api.borisinc.com/paid/ping");
  assert.equal(r.error, "no buyer wallet configured");
  assert.match(r.hint, /AEGIS_BUYER_KEY/);
});

test("no key -> procure instructive error", async () => {
  const r = await procure("steam deals", 0.05);
  assert.equal(r.error, "no buyer wallet configured");
});

test("asText serializes + truncates + handles bigint", () => {
  assert.equal(asText({ a: 1n }), '{"a":"1"}');
  assert.equal(asText({ s: "x".repeat(9000) }).length, 6000);
});

test("getAegisTools without @langchain/core -> instructive error", async () => {
  let installed = true;
  try { await import("@langchain/core/tools"); } catch { installed = false; }
  if (installed) {
    const tools = await getAegisTools();
    assert.equal(tools.length, 4);
    assert.deepEqual(tools.map(t => t.name),
      ["aegis_discover", "aegis_trust_check", "aegis_paid_get", "aegis_procure"]);
  } else {
    await assert.rejects(() => getAegisTools(), /npm i @langchain\/core/);
  }
});

for (const k of KEYS) if (saved[k] !== undefined) process.env[k] = saved[k];
