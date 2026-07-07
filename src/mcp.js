#!/usr/bin/env node
/** aegis-buy MCP server — give any MCP-capable agent a safe x402 wallet.
 *
 *  stdio transport. Config comes from env: AEGIS_BUY_KEY (wallet private key),
 *  AEGIS_BUY_POLICY (policy json path), AEGIS_BUY_LEDGER (ledger jsonl path),
 *  AEGIS_HUB (hub base url), AEGIS_BUY_DRY_RUN=1 (never actually pay).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { BuyClient } from "./client.js";

let _client = null;

function getClient() {
  if (_client == null) {
    _client = new BuyClient({
      dryRun: ["1", "true", "yes"].includes(process.env.AEGIS_BUY_DRY_RUN || ""),
    });
  }
  return _client;
}

function asContent(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

export const server = new McpServer({ name: "aegis-buy", version: "0.1.0" });

server.registerTool(
  "buy_get",
  {
    description:
      "Buy one x402 (HTTP 402 + USDC) resource safely: probes the price, checks the " +
      "service against the Aegis trust registry, enforces the local spend policy, pays " +
      "only if allowed, and records a receipt. Returns {ok, status, data, priceUsd, " +
      "tx, receipt, blocked, reason}. params_json: optional JSON object of query params.",
    inputSchema: {
      url: z.string().describe("The x402 resource URL to buy"),
      params_json: z.string().optional().describe("Optional JSON object of query params"),
    },
  },
  async ({ url, params_json }) => {
    let params = null;
    if (params_json) {
      try {
        params = JSON.parse(params_json);
      } catch (e) {
        return asContent({ ok: false, blocked: true,
                           reason: `params_json is not valid JSON: ${e.message}` });
      }
    }
    return asContent(await getClient().get(url, params));
  },
);

server.registerTool(
  "procure",
  {
    description:
      "Procure a capability via the Aegis hub: describe what you need in plain words " +
      "(e.g. 'live ETH price') and a USD budget; Aegis finds a trusted provider and " +
      "delivers the data. Budget must be within the local spend policy's per-call cap.",
    inputSchema: {
      need: z.string().describe("Plain-words description of the capability needed"),
      budget: z.number().describe("USD budget for this procurement"),
    },
  },
  async ({ need, budget }) => asContent(await getClient().procure(need, budget)),
);

server.registerTool(
  "trust_gate",
  {
    description:
      "Check a service's Aegis trust tier and score WITHOUT paying it. Free in basic " +
      "mode; in strict mode it performs a paid $0.002 hub trust check (policy-capped).",
    inputSchema: {
      url: z.string().describe("Service URL to check"),
    },
  },
  async ({ url }) => asContent(await getClient().gate.check(url)),
);

server.registerTool(
  "spend_stats",
  {
    description:
      "Local spend summary from the receipts ledger: today's spend, total spend, " +
      "purchase counts by status, and the five most recent purchases.",
    inputSchema: {},
  },
  async () => asContent(getClient().stats()),
);

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

{
  // Run as CLI when invoked directly or via the npm bin symlink.
  const { fileURLToPath } = await import("node:url");
  const { realpathSync } = await import("node:fs");
  let direct = false;
  try {
    direct = process.argv[1] != null &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    direct = false;
  }
  if (direct) {
    main().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
}
