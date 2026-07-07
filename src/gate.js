/** Pre-payment trust gate — ask the Aegis hub about a service BEFORE paying it.
 *
 *  basic  : free signals — GET /discover?query=<host>, fallback /registry.json preview.
 *  strict : paid GET /trust?url= ($0.002) through the client's OWN payment flow,
 *           so the check itself is policy-capped and ledgered.
 *  off    : skip (policy price caps still apply).
 */
import { hostOf } from "./policy.js";

export const DEFAULT_HUB = "https://aegis.borisinc.com";
export const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function defaultHttpGet(timeoutMs) {
  return (url, params = null) => {
    const u = new URL(url);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null) u.searchParams.set(k, String(v));
      }
    }
    return fetch(u, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  };
}

export class TrustGate {
  /** payGet(url, params) -> client-result object; used only in strict mode.
   *  httpGet is injectable for tests; defaults to global fetch. */
  constructor({ hub = null, mode = "basic", payGet = null, httpGet = null, timeoutMs = 15000 } = {}) {
    this.hub = (hub || process.env.AEGIS_HUB || DEFAULT_HUB).replace(/\/+$/, "");
    this.mode = mode;
    this.payGet = payGet;
    this.httpGet = httpGet || defaultHttpGet(timeoutMs);
    this._cache = new Map(); // host -> [epochMs, info]
  }

  _match(services, host) {
    for (const s of services || []) {
      if (hostOf(s.url || "") === host) {
        return {
          tier: s.tier || "unverified",
          trust_score: s.trust_score ?? null,
          name: s.name ?? null,
          url: s.url ?? null,
        };
      }
    }
    return null;
  }

  /** Return {tier, trust_score, source, ...}. Never throws. */
  async check(url) {
    if (this.mode === "off") return { tier: null, trust_score: null, source: "off" };
    const host = hostOf(url);
    if (!host) return { tier: "unverified", trust_score: null, source: "bad-url" };

    const hit = this._cache.get(host);
    if (hit && Date.now() - hit[0] < CACHE_TTL_MS) return hit[1];

    const info = this.mode === "strict" ? await this._strict(url) : await this._basic(host);
    this._cache.set(host, [Date.now(), info]);
    return info;
  }

  async _basic(host) {
    let info = null;
    try {
      const r = await this.httpGet(`${this.hub}/discover`, { query: host });
      if (r.status === 200) info = this._match((await r.json()).results, host);
    } catch {
      // free signal unavailable; try the registry preview
    }
    if (info == null) {
      try {
        const r = await this.httpGet(`${this.hub}/registry.json`, null);
        if (r.status === 200) info = this._match((await r.json()).services, host);
      } catch {
        // registry preview unavailable too
      }
    }
    if (info == null) {
      info = { tier: "unverified", trust_score: null, source: "unknown-to-aegis" };
    } else {
      info.source = "aegis-free-signals";
    }
    return info;
  }

  async _strict(url) {
    if (!this.payGet) {
      return { tier: "unverified", trust_score: null, source: "strict-unavailable (no payment client)" };
    }
    try {
      const res = await this.payGet(`${this.hub}/trust`, { url });
      const data = res && typeof res === "object" ? res.data : null;
      if (data && typeof data === "object" && ("tier" in data || "trust_score" in data)) {
        return {
          tier: data.tier || "unverified",
          trust_score: data.trust_score ?? null,
          recommendation: data.recommendation ?? null,
          source: "aegis-paid-trust-check",
        };
      }
      const reason = (res || {}).reason ?? (res || {}).status;
      return { tier: "unverified", trust_score: null, source: `strict-check-failed (${reason})` };
    } catch (e) {
      const msg = String(e && e.message != null ? e.message : e).slice(0, 80);
      return { tier: "unverified", trust_score: null, source: `strict-check-error (${msg})` };
    }
  }
}
