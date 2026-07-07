/** BuyClient — the safe x402 buyer.
 *
 *  Flow per purchase:  probe (free GET, expect 402) -> parse price from the
 *  payment-required header -> trust gate (Aegis) -> local spend policy ->
 *  pay via the official @x402/fetch wrapper -> record receipt in the ledger.
 */
import { TrustGate, DEFAULT_HUB } from "./gate.js";
import { Ledger } from "./ledger.js";
import { SpendPolicy } from "./policy.js";

export const USDC_DECIMALS = 6;
export const PAYMENT_REQUIRED_HEADER = "payment-required";
export const PAYMENT_RESPONSE_HEADER = "payment-response";

/** Build a payment-capable fetch from the official x402 v2 SDK:
 *  viem signer -> ExactEvmScheme -> x402Client -> wrapFetchWithPayment. */
export async function makeBuyer(privateKey, network) {
  const [{ wrapFetchWithPayment }, { x402Client }, { ExactEvmScheme }, { privateKeyToAccount }] =
    await Promise.all([
      import("@x402/fetch"),
      import("@x402/core/client"),
      import("@x402/evm/exact/client"),
      import("viem/accounts"),
    ]);
  const signer = privateKeyToAccount(privateKey);
  const client = new x402Client();
  client.register(network, new ExactEvmScheme(signer));
  return wrapFetchWithPayment(globalThis.fetch, client);
}

/** Decode the base64 payment-required header into the requirements object. */
export function decodePaymentRequired(headerValue) {
  const pad = headerValue + "=".repeat((4 - (headerValue.length % 4)) % 4);
  return JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
}

/** Best-priced accept for our network (else any), USDC 6dp -> USD. Null if unparseable. */
export function parsePriceUsd(pr, network) {
  const accepts = (pr && pr.accepts) || [];
  const amounts = [];
  for (const a of accepts) {
    const amt = a.amount ?? a.maxAmountRequired ?? a.max_amount_required;
    if (amt == null) continue;
    const n = Number(String(amt));
    if (!Number.isFinite(n)) continue;
    amounts.push([a.network === network, n / 10 ** USDC_DECIMALS]);
  }
  if (!amounts.length) return null;
  const ours = amounts.filter(([m]) => m).map(([, u]) => u);
  const pool = ours.length ? ours : amounts.map(([, u]) => u);
  return Math.min(...pool);
}

export function appendParams(url, params) {
  if (!params || !Object.keys(params).length) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function parseBody(text) {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headerOf(resLike, name) {
  const h = resLike && resLike.headers;
  return h && typeof h.get === "function" ? h.get(name) : null;
}

function errStr(e, max) {
  return String(e && e.message != null ? e.message : e).slice(0, max);
}

function defaultHttpGet(timeoutMs) {
  return (url) => fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
}

export class BuyClient {
  /** Options: privateKey (default env AEGIS_BUY_KEY), policy, network, dryRun,
   *  ledger, hub (default env AEGIS_HUB), timeoutMs, httpGet/payFetch (test injection). */
  constructor({ privateKey = null, policy = null, network = "eip155:8453", dryRun = false,
                ledger = null, hub = null, timeoutMs = 60000,
                httpGet = null, payFetch = null } = {}) {
    this.network = network;
    this.dryRun = Boolean(dryRun);
    this.timeoutMs = timeoutMs;
    this.hub = (hub || process.env.AEGIS_HUB || DEFAULT_HUB).replace(/\/+$/, "");
    this._key = privateKey || process.env.AEGIS_BUY_KEY || null;
    this.ledger = ledger || new Ledger();
    this.policy = policy || SpendPolicy.load({ ledger: this.ledger });
    if (this.policy.ledger == null) this.policy.ledger = this.ledger;
    this._httpGet = httpGet || defaultHttpGet(timeoutMs);
    this._payFetch = payFetch; // built lazily from the x402 SDK when null
    this.gate = new TrustGate({
      hub: this.hub,
      mode: this.policy.trustMode,
      payGet: (url, params) => this.get(url, params, { skipGate: true }),
      httpGet: (url, params) => this._httpGet(appendParams(url, params)),
    });
  }

  // ---- payment plumbing ----
  async _buyer() {
    if (!this._payFetch) {
      if (!this._key) throw new Error("no private key: pass privateKey or set AEGIS_BUY_KEY");
      this._payFetch = await makeBuyer(this._key, this.network);
    }
    return this._payFetch;
  }

  /** Purchase an x402 resource. Returns {ok, status, body, tx, error}. */
  async _pay(url) {
    const out = { ok: false, status: null, body: null, tx: null, error: null };
    try {
      const payFetch = await this._buyer();
      const r = await payFetch(url, { method: "GET" });
      out.status = r.status;
      out.body = await r.text();
      out.tx = headerOf(r, PAYMENT_RESPONSE_HEADER);
      out.ok = r.status === 200;
    } catch (e) {
      out.error = errStr(e, 200);
    }
    return out;
  }

  // ---- public API ----
  /** Buy (or fetch, if free) one x402 resource. Never pays without passing
   *  the trust gate + spend policy. Returns
   *  {ok, status, data, priceUsd, tx, receipt, blocked, reason}. */
  async get(url, params = null, { skipGate = false } = {}) {
    url = appendParams(url, params);
    const res = { ok: false, status: null, data: null, priceUsd: null,
                  tx: null, receipt: null, blocked: false, reason: null };

    // 1. probe: plain GET, expect 402 (or free 200)
    let probe;
    try {
      probe = await this._httpGet(url);
    } catch (e) {
      res.reason = `probe failed: ${errStr(e, 150)}`;
      return res;
    }
    res.status = probe.status;
    if (probe.status === 200) {
      res.ok = true;
      res.priceUsd = 0.0;
      res.data = parseBody(await probe.text());
      res.reason = "free";
      this.ledger.record(url, 0.0, "free");
      return res;
    }
    if (probe.status !== 402) {
      res.reason = `expected 402, got ${probe.status}`;
      return res;
    }

    // 2. parse price from payment-required header (some servers use the 402 body)
    const hdr = headerOf(probe, PAYMENT_REQUIRED_HEADER);
    let price = null;
    if (hdr) {
      try {
        price = parsePriceUsd(decodePaymentRequired(hdr), this.network);
      } catch {
        price = null;
      }
    }
    if (price == null) {
      try {
        price = parsePriceUsd(JSON.parse(await probe.text()), this.network);
      } catch {
        price = null;
      }
    }
    res.priceUsd = price;

    // 3. trust gate (skipped for the gate's own hub calls to avoid recursion)
    let tier = null;
    if (!skipGate) {
      const g = await this.gate.check(url);
      tier = g.tier;
      res.trust = g;
    }

    // 4. local spend policy
    const { allowed, reason } = this.policy.check(url, price, tier);
    if (!allowed) {
      res.blocked = true;
      res.reason = reason;
      this.ledger.record(url, price, "blocked", null, { reason });
      return res;
    }

    // 5. dry run stops here
    if (this.dryRun) {
      res.ok = true;
      res.reason = "dry_run";
      res.receipt = { would_pay: price };
      res.wouldPay = price;
      this.ledger.record(url, price, "dry_run");
      return res;
    }

    // 6. pay
    const pay = await this._pay(url);
    res.status = pay.status;
    res.tx = pay.tx;
    if (!pay.ok) {
      res.reason = pay.error || `payment fetch failed (status ${pay.status})`;
      this.ledger.record(url, price, "failed", pay.tx, { error: res.reason });
      return res;
    }

    const data = parseBody(pay.body);
    res.ok = true;
    res.data = data;
    res.reason = "paid";

    // 7. Aegis delivery receipt, if present
    const receipt = data && typeof data === "object" && !Array.isArray(data)
      ? (data.receipt ?? null) : null;
    if (receipt != null) res.receipt = receipt;
    this.ledger.record(url, price, "paid", pay.tx, receipt);
    return res;
  }

  /** Ask the Aegis hub to procure a capability within budget (paid route). */
  async procure(need, budget) {
    const b = Number(budget);
    if (budget == null || budget === "" || !Number.isFinite(b)) {
      return { ok: false, blocked: true, reason: `bad budget: ${JSON.stringify(budget)}` };
    }
    if (b > this.policy.maxPerCallUsd + 1e-9) {
      return { ok: false, blocked: true,
               reason: `budget $${b.toFixed(6)} exceeds policy max_per_call_usd ` +
                       `$${this.policy.maxPerCallUsd.toFixed(6)}` };
    }
    return this.get(`${this.hub}/procure`, { need, budget: b });
  }

  stats() {
    return this.ledger.stats();
  }
}
