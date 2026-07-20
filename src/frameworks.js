/** Framework tools for the Aegis machine economy (LangChain.js).
 *  JS parity of aegis_buy.frameworks (Python 0.2.0). CrewAI is Python-only.
 *  All spend goes through BuyClient + SpendPolicy (local caps, trust gate);
 *  no key configured -> paid actions return an instructive error instead of throwing. */
import { BuyClient } from "./client.js";
import { SpendPolicy } from "./policy.js";

const HUB = (process.env.AEGIS_HUB || "https://aegis.borisinc.com").replace(/\/+$/, "");
const NO_KEY = {
  error: "no buyer wallet configured",
  hint: "set AEGIS_BUYER_KEY (or X402_PRIVATE_KEY) to a funded Base-USDC wallet private key; " +
        "spend is capped locally by SpendPolicy (default $0.05/call, $1.00/day, provisional+ sellers only)",
};

export function makeClient(privateKey = null, policyKw = {}) {
  const key = privateKey || process.env.AEGIS_BUYER_KEY || process.env.X402_PRIVATE_KEY || process.env.AEGIS_BUY_KEY;
  if (!key) return null;
  const policy = new SpendPolicy({
    max_per_call_usd: Number(process.env.AEGIS_MAX_PER_CALL_USD || "0.05"),
    max_per_day_usd: Number(process.env.AEGIS_MAX_PER_DAY_USD || "1.00"),
    min_tier: process.env.AEGIS_MIN_TIER || "provisional",
    ...policyKw,
  });
  return new BuyClient({ privateKey: key, policy });
}

export async function discover(query, category = "", minTrust = 35) {
  const u = new URL(`${HUB}/discover`);
  u.searchParams.set("query", query);
  if (category) u.searchParams.set("category", category);
  u.searchParams.set("min_trust", String(minTrust));
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`discover HTTP ${r.status}`);
  const d = await r.json();
  let svcs = (d && typeof d === "object" && !Array.isArray(d)) ? (d.results || d.services || d) : d;
  if (Array.isArray(svcs)) {
    svcs = svcs.slice(0, 8).filter((s) => s && typeof s === "object")
      .map((s) => ({ url: s.url, name: s.name, category: s.category, tier: s.tier,
                     trust_score: s.trust_score, price_usd: s.price_usd }));
  }
  return { query, results: svcs };
}

export async function trustCheck(url, privateKey = null) {
  const u = new URL(`${HUB}/trust`);
  u.searchParams.set("url", url);
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
  if (r.status === 200) return r.json();
  const c = makeClient(privateKey);
  if (!c) return { ...NO_KEY, note: "first trust check per caller is free; this one needs payment ($0.01)" };
  return c.get(`${HUB}/trust`, { url });
}

export async function paidGet(url, privateKey = null) {
  const c = makeClient(privateKey);
  if (!c) return { ...NO_KEY };
  return c.get(url);
}

export async function procure(need, budget, privateKey = null) {
  const c = makeClient(privateKey);
  if (!c) return { ...NO_KEY };
  return c.procure(need, Number(budget));
}

export function asText(result) {
  try { return JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 6000); }
  catch { return String(result).slice(0, 6000); }
}

/** LangChain.js tools. Requires optional peer dep: npm i @langchain/core
 *  Returns [aegis_discover, aegis_trust_check, aegis_paid_get, aegis_procure]. */
export async function getAegisTools({ privateKey = null } = {}) {
  let toolMod, z;
  try {
    toolMod = await import("@langchain/core/tools");
    z = (await import("zod")).z;
  } catch {
    throw new Error("LangChain extra not installed — npm i @langchain/core (aegis-buy keeps it optional)");
  }
  const { tool } = toolMod;
  const wrap = (fn) => async (input) => {
    try { return asText(await fn(input)); }
    catch (e) { return asText({ error: String(e && e.message ? e.message : e).slice(0, 200) }); }
  };
  return [
    tool(wrap(({ query, category, min_trust }) => discover(query, category || "", min_trust ?? 35)), {
      name: "aegis_discover",
      description: "Search the Aegis registry of pay-per-call (x402) machine-economy APIs by capability. " +
        "Free, no wallet needed. Returns top services with trust tier and price. " +
        "Use this to find data/services an agent can buy with USDC micropayments.",
      schema: z.object({ query: z.string().describe("capability to search for"),
                         category: z.string().optional(), min_trust: z.number().optional() }),
    }),
    tool(wrap(({ url }) => trustCheck(url, privateKey)), {
      name: "aegis_trust_check",
      description: "Check a verification-backed trust score (0-100 + tier + recommendation) for an x402 service URL " +
        "BEFORE paying it. First check per caller is free; afterwards $0.01 paid from your capped wallet. " +
        "Always run this before paying an unfamiliar API.",
      schema: z.object({ url: z.string().describe("x402 service URL to vet") }),
    }),
    tool(wrap(({ url }) => paidGet(url, privateKey)), {
      name: "aegis_paid_get",
      description: "Fetch a paid x402 URL, paying automatically in USDC on Base within local SpendPolicy caps " +
        "(default $0.05/call, $1.00/day) after an Aegis trust-gate check. Returns the paid response body.",
      schema: z.object({ url: z.string().describe("paid x402 endpoint URL") }),
    }),
    tool(wrap(({ need, budget }) => procure(need, budget, privateKey)), {
      name: "aegis_procure",
      description: "Ask the Aegis hub to procure a capability within a USD budget: it discovers, trust-ranks, " +
        "and buys from the best x402 seller, with failover. Budget is enforced by local SpendPolicy caps.",
      schema: z.object({ need: z.string().describe("capability needed"),
                         budget: z.number().describe("max USD to spend") }),
    }),
  ];
}
