/** Shared test helpers — NO real network, NO real payments, tmp-file ledgers. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Ledger } from "../src/ledger.js";

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aegis-buy-js-"));
}

export function tmpLedger() {
  return new Ledger(path.join(tmpDir(), "ledger.jsonl"));
}

/** Minimal Response-like object with .status, .headers.get(), .json(), .text(). */
export function fakeRes({ status = 200, json = null, headers = {}, text = null } = {}) {
  const body = text != null ? text : (json != null ? JSON.stringify(json) : "");
  return {
    status,
    headers: new Headers(headers),
    async json() {
      if (json == null) throw new Error("no json");
      return json;
    },
    async text() {
      return body;
    },
  };
}

/** Base64 payment-required header for an exact-scheme accept. */
export function prHeader(amountAtomic, network = "eip155:8453") {
  const pr = {
    x402Version: 2,
    accepts: [{ scheme: "exact", network, amount: String(amountAtomic),
                asset: "usdc", payTo: "0x0000000000000000000000000000000000000000" }],
  };
  // strip padding to exercise the unpadded-base64 path
  return Buffer.from(JSON.stringify(pr)).toString("base64").replace(/=+$/, "");
}
