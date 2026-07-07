/** Local spend policy — hard caps the wallet's downside before any payment. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PATH = "~/.aegis-buy/policy.json";
export const TIER_RANK = { unverified: 0, provisional: 1, verified: 2, trusted: 3 };
export const TRUST_MODES = ["basic", "strict", "off"];

export function expandUser(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function hostOf(url) {
  try {
    return (new URL(url).hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

function domainMatch(host, domain) {
  const d = String(domain).toLowerCase().replace(/^\.+/, "");
  return host === d || host.endsWith("." + d);
}

/** Spend policy loaded from JSON. All checks are local and free. */
export class SpendPolicy {
  constructor(opts = {}) {
    const {
      max_per_call_usd = 0.05,
      max_per_day_usd = 1.0,
      max_total_usd = null,
      min_tier = "provisional",
      allow_domains = null,
      deny_domains = null,
      trust_mode = "basic",
      ledger = null,
    } = opts;
    this.maxPerCallUsd = Number(max_per_call_usd);
    this.maxPerDayUsd = Number(max_per_day_usd);
    this.maxTotalUsd = max_total_usd == null ? null : Number(max_total_usd);
    if (!(min_tier in TIER_RANK)) {
      throw new Error(`min_tier must be one of ${Object.keys(TIER_RANK).sort().join(", ")}`);
    }
    this.minTier = min_tier;
    this.allowDomains = [...(allow_domains || [])];
    this.denyDomains = [...(deny_domains || [])];
    if (!TRUST_MODES.includes(trust_mode)) {
      throw new Error(`trust_mode must be one of ${TRUST_MODES.join(", ")}`);
    }
    this.trustMode = trust_mode;
    this.ledger = ledger; // wired by BuyClient; used for day/total spend
  }

  /** Load from JSON file. Missing file -> safe defaults.
   *  Path resolution: explicit arg > env AEGIS_BUY_POLICY > ~/.aegis-buy/policy.json */
  static load({ path: p = null, ledger = null } = {}) {
    const resolved = expandUser(p || process.env.AEGIS_BUY_POLICY || DEFAULT_PATH);
    let cfg = {};
    if (fs.existsSync(resolved)) {
      cfg = JSON.parse(fs.readFileSync(resolved, "utf8"));
    }
    const known = new Set([
      "max_per_call_usd", "max_per_day_usd", "max_total_usd", "min_tier",
      "allow_domains", "deny_domains", "trust_mode",
    ]);
    const filtered = Object.fromEntries(Object.entries(cfg).filter(([k]) => known.has(k)));
    return new SpendPolicy({ ...filtered, ledger });
  }

  /** Return {allowed, reason}. Never throws on bad input — blocks instead. */
  check(url, priceUsd, tier = null) {
    const block = (reason) => ({ allowed: false, reason });

    const host = hostOf(url);
    if (!host) return block(`cannot parse host from url: ${JSON.stringify(url)}`);

    for (const d of this.denyDomains) {
      if (domainMatch(host, d)) return block(`domain '${host}' is on deny list (${d})`);
    }
    if (this.allowDomains.length && !this.allowDomains.some((d) => domainMatch(host, d))) {
      return block(`domain '${host}' not on allow list`);
    }

    if (priceUsd == null) return block("price unknown — refusing to pay blind");
    const price = Number(priceUsd);
    if (!Number.isFinite(price)) return block(`unparseable price: ${JSON.stringify(priceUsd)}`);
    if (price < 0) return block(`negative price: ${price}`);
    if (price > this.maxPerCallUsd + 1e-9) {
      return block(`price $${price.toFixed(6)} exceeds max_per_call_usd $${this.maxPerCallUsd.toFixed(6)}`);
    }

    if (this.ledger != null) {
      const day = this.ledger.daySpend();
      if (day + price > this.maxPerDayUsd + 1e-9) {
        return block(`would exceed max_per_day_usd $${this.maxPerDayUsd.toFixed(6)} ` +
                     `(spent $${day.toFixed(6)} today + $${price.toFixed(6)})`);
      }
      if (this.maxTotalUsd != null) {
        const total = this.ledger.totalSpend();
        if (total + price > this.maxTotalUsd + 1e-9) {
          return block(`would exceed max_total_usd $${this.maxTotalUsd.toFixed(6)} ` +
                       `(spent $${total.toFixed(6)} total + $${price.toFixed(6)})`);
        }
      }
    }

    if (tier === "flagged") return block("service is FLAGGED by the trust gate — always blocked");
    if (this.trustMode !== "off" && tier != null) {
      if ((TIER_RANK[tier] ?? 0) < TIER_RANK[this.minTier]) {
        return block(`trust tier '${tier}' below min_tier '${this.minTier}'`);
      }
    }

    return { allowed: true, reason: "ok" };
  }
}
