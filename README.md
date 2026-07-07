# aegis-buy

**Trust-gated buyer client for the x402 machine economy.** Your agent wants to pay
APIs with USDC over HTTP 402 — this package makes sure it never pays the wrong
service, the wrong amount, or more than you allowed.

Powered by [Aegis](https://aegis.borisinc.com), the trusted agent-commerce hub.
Buyer docs: https://aegis.borisinc.com/buyer

```
probe (free) -> parse price -> Aegis trust gate -> local spend policy -> pay -> receipt
```

Every step before "pay" is free and local. Nothing settles unless the service
passes the trust gate **and** your policy caps. Payments use the official
[x402 v2 SDK](https://docs.x402.org) (`@x402/fetch` + `@x402/evm`) with a
[viem](https://viem.sh) signer on Base mainnet (`eip155:8453`).

## Install

```bash
npm i aegis-buy            # library + MCP server (bin: aegis-buy-mcp)
npx --package=aegis-buy aegis-buy-mcp   # run the MCP server without installing
```

## Quickstart

```js
import { BuyClient } from "aegis-buy";

const client = new BuyClient();  // key from AEGIS_BUY_KEY env
const r = await client.get("https://api.example.com/price", { symbol: "ETH" });
console.log(r.ok, r.priceUsd, r.data);

// Don't know a provider? Let the hub find a trusted one within budget:
const p = await client.procure("live ETH price", 0.01);

// Test everything without spending a cent:
const dry = new BuyClient({ dryRun: true });
```

`get()` resolves to `{ok, status, data, priceUsd, tx, receipt, blocked, reason}`
(plus `trust` with the gate verdict and `wouldPay` on dry runs).

### Environment variables

| Var | Meaning | Default |
|---|---|---|
| `AEGIS_BUY_KEY` | EVM private key of the buyer wallet (funds USDC on Base) | — |
| `AEGIS_BUY_POLICY` | Path to spend policy JSON | `~/.aegis-buy/policy.json` |
| `AEGIS_BUY_LEDGER` | Path to JSON-lines receipts ledger | `~/.aegis-buy/ledger.jsonl` |
| `AEGIS_HUB` | Aegis hub base URL | `https://aegis.borisinc.com` |
| `AEGIS_BUY_DRY_RUN` | `1` = MCP server never actually pays | off |

### Spend policy (`~/.aegis-buy/policy.json`)

```json
{
  "max_per_call_usd": 0.05,
  "max_per_day_usd": 1.00,
  "max_total_usd": 10.00,
  "min_tier": "provisional",
  "allow_domains": [],
  "deny_domains": ["sketchy.example"],
  "trust_mode": "basic"
}
```

- `max_per_call_usd` / `max_per_day_usd` / `max_total_usd` — hard USD caps. Day and
  total spend are computed from the local ledger.
- `min_tier` — minimum Aegis trust tier: `unverified` < `provisional` < `verified`
  < `trusted`. Services flagged by Aegis are **always** blocked.
- `allow_domains` / `deny_domains` — domain allow/deny lists (subdomains match).
- `trust_mode` — `basic` (free Aegis signals: `/discover` + registry preview,
  cached 10 min), `strict` (paid $0.002 verification-backed trust check per
  service, itself policy-capped and ledgered), or `off`.

Missing file = safe defaults (5c/call, $1/day, provisional+, basic gate).

## MCP server

Give Claude Desktop (or any MCP client) a safe x402 wallet:

```json
{
  "mcpServers": {
    "aegis-buy": {
      "command": "npx",
      "args": ["-y", "--package=aegis-buy", "aegis-buy-mcp"],
      "env": {
        "AEGIS_BUY_KEY": "0xYOUR_BUYER_WALLET_PRIVATE_KEY",
        "AEGIS_BUY_POLICY": "~/.aegis-buy/policy.json"
      }
    }
  }
}
```

(If installed globally, `"command": "aegis-buy-mcp"` with no args also works.)

Tools: `buy_get(url, params_json)` · `procure(need, budget)` · `trust_gate(url)` · `spend_stats()`.

## Safety model

1. **Local spend policy** — per-call, per-day, and lifetime USD caps enforced before
   any payment; domain allow/deny lists. The wallet's downside is bounded by config.
2. **Pre-payment trust gate** — services are checked against Aegis's continuously
   verified registry *before* money moves. Unknown services default to `unverified`;
   flagged services are always blocked.
3. **Receipts ledger** — every attempt (paid, blocked, failed, dry-run, free) lands
   in a local JSON-lines ledger; caps are computed from it, so they survive restarts.
4. **No blind buys** — if the price can't be parsed from the 402 challenge, the
   purchase is refused.
5. **Delivery protection via Aegis** — routes purchased through the hub use
   auth-then-capture: your payment only settles after the upstream actually
   delivers, so you are never charged for non-delivery.

Use a **dedicated buyer wallet** funded with only what you're willing to spend —
defense in depth on top of the policy caps.

## Links

- Hub: https://aegis.borisinc.com — buyer guide: https://aegis.borisinc.com/buyer —
  free discovery: `GET /discover?query=...`
- x402 protocol: HTTP 402 + USDC on Base (`eip155:8453`) — https://docs.x402.org

MIT license.
