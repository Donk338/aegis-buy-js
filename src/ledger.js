/** Receipts ledger — every purchase attempt (paid, blocked, failed, dry_run, free)
 *  lands in a local JSON-lines file, one JSON object per line.
 *
 *  Deliberately NOT interoperable with the Python aegis-buy sqlite ledger:
 *  separate default file (~/.aegis-buy/ledger.jsonl), separate format. */
import fs from "node:fs";
import path from "node:path";

import { expandUser } from "./policy.js";

export const DEFAULT_PATH = "~/.aegis-buy/ledger.jsonl";
export const SPEND_STATUSES = ["paid"]; // statuses that count as money out the door

export class Ledger {
  constructor(p = null) {
    this.path = expandUser(p || process.env.AEGIS_BUY_LEDGER || DEFAULT_PATH);
    fs.mkdirSync(path.dirname(this.path) || ".", { recursive: true });
    if (!fs.existsSync(this.path)) fs.writeFileSync(this.path, "");
  }

  _rows() {
    let text = "";
    try {
      text = fs.readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const rows = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        // skip corrupt lines rather than crash spend accounting
      }
    }
    return rows;
  }

  /** Append a row; returns row id. status: paid|blocked|failed|dry_run|free. */
  record(url, priceUsd, status, tx = null, receipt = null) {
    const id = this._rows().length + 1;
    const entry = {
      id,
      ts: Date.now() / 1000,
      url,
      price_usd: priceUsd == null ? null : Number(priceUsd),
      status,
      tx: tx ?? null,
      receipt: receipt ?? null,
    };
    fs.appendFileSync(this.path, JSON.stringify(entry) + "\n");
    return id;
  }

  _dayStart() {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  }

  /** USD actually paid since UTC midnight. */
  daySpend() {
    const start = this._dayStart();
    return this._rows()
      .filter((r) => r.ts >= start && SPEND_STATUSES.includes(r.status))
      .reduce((s, r) => s + (Number(r.price_usd) || 0), 0);
  }

  totalSpend() {
    return this._rows()
      .filter((r) => SPEND_STATUSES.includes(r.status))
      .reduce((s, r) => s + (Number(r.price_usd) || 0), 0);
  }

  stats() {
    const rows = this._rows();
    const byStatus = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const round6 = (x) => Math.round(x * 1e6) / 1e6;
    return {
      purchases: rows.length,
      by_status: byStatus,
      day_spend_usd: round6(this.daySpend()),
      total_spend_usd: round6(this.totalSpend()),
      recent: rows.slice(-5).reverse().map((r) => ({
        ts: r.ts, url: r.url, price_usd: r.price_usd, status: r.status, tx: r.tx,
      })),
      ledger_path: this.path,
    };
  }
}
