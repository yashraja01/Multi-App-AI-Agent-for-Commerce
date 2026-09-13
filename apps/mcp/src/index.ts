#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type HolderProof, holderChallenge, newNonce, signValue } from "@mercury/core";
import { readWallet } from "@mercury/seed";
import { z } from "zod";

/**
 * Mercury's MCP server: the merchant, made transactable by any AI buyer.
 *
 * Two things about its shape are deliberate.
 *
 * First, it is a *thin client of the Mercury gateway*, not a second copy of the
 * engine. The gateway stays the single execution point (D5) -- one store, one
 * ledger, one rail instance -- so a purchase made by an external Claude appears
 * live in Mission Control, and there is exactly one place where money moves.
 *
 * Second, and more important: **no tool here accepts a price.** A buyer agent
 * says what it wants in words and reads back what the gate decided. There is no
 * argument anywhere in this file through which a model could name an amount, so
 * no amount a model invents can ever be charged. An MCP server that took
 * `total_cents` from its caller would put an LLM in the money path, which is
 * precisely the anti-pattern Mercury exists to avoid.
 */

const BASE = (process.env["MERCURY_URL"] ?? "http://localhost:3000").replace(/\/+$/u, "");
const WALLET = process.env["MERCURY_WALLET"] ?? "./buyer-wallet.json";

/**
 * The buyer's wallet.
 *
 * This server signs on behalf of the buyer, so it holds the delegated agent
 * private keys -- the same asymmetry a real buyer agent would have. The
 * merchant never sees them; it only ever checks a signature against the public
 * key named inside the mandate the human signed.
 */
/**
 * Prove we hold the mandate.
 *
 * Without this, a mandate id is a bearer token: anyone who learns one can spend
 * it. The signature is over a fresh nonce and the current time, so it cannot be
 * captured and reused.
 */
function proveHolder(mandateId: string): HolderProof {
  const entry = readWallet(WALLET).find((a) => a.mandate_id === mandateId);
  if (entry === undefined) {
    throw new GatewayError(
      `No key for ${mandateId} in ${WALLET}. Run \`npm run seed\` to mint a buyer wallet, ` +
        "or point MERCURY_WALLET at yours.",
    );
  }
  const body = { mandate_id: mandateId, nonce: newNonce(), issued_at: new Date().toISOString() };
  return { ...body, signature: signValue(holderChallenge(body), entry.agent_private_key) };
}

class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (e) {
    throw new GatewayError(
      `Cannot reach the Mercury gateway at ${BASE}. Start it with \`npm run dev\`. (${(e as Error).message})`,
    );
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new GatewayError(`Gateway returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new GatewayError(message);
  }
  return body as T;
}

/** Every tool answers in JSON, so the calling model parses rather than reads prose. */
function json(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(e: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return { content: [{ type: "text", text: (e as Error).message }], isError: true };
}

const server = new McpServer(
  { name: "mercury", version: "0.1.0" },
  {
    instructions:
      "Mercury makes a merchant transactable by an AI buyer. You cannot set a price here: " +
      "describe what you want, and the merchant's own agent proposes a cart that a deterministic " +
      "policy gate then prices and approves or refuses. A quote returns a single-use intent token; " +
      "`pay` redeems exactly one. If a quote comes back needing approval, hand the link to your " +
      "human and stop -- do not try to route around it. All amounts are integer cents. " +
      "Every spending call is signed with the buyer's delegated agent key, so a mandate id alone " +
      "buys nothing.",
  },
);

/* --------------------------------------------------------------- discovery */

server.registerTool(
  "list_merchants",
  {
    title: "List merchants",
    description:
      "Who is reachable on this rail, what vertical each one serves, and where its product feed is. " +
      "Start here.",
    inputSchema: {},
  },
  async () => {
    try {
      const card = await call<{
        merchants: unknown[];
        constraints: string[];
        authorization: unknown;
      }>("/.well-known/agent.json");
      return json({
        merchants: card.merchants,
        how_this_works: card.constraints,
        authorization: card.authorization,
      });
    } catch (e) {
      return failure(e);
    }
  },
);

server.registerTool(
  "search_catalog",
  {
    title: "Search a merchant's catalogue",
    description:
      "The merchant's machine-readable feed: stable SKUs, list price in cents, live stock and " +
      "minimum order quantity. List price is a ceiling for your expectations, not a floor -- the " +
      "floor is the merchant's own and is never published.",
    inputSchema: {
      merchant_id: z.string().describe("From list_merchants, e.g. mch_quick."),
      query: z
        .string()
        .optional()
        .describe("Case-insensitive substring of a title or SKU. Omit to list everything."),
      category: z.string().optional().describe("Restrict to one category from the feed."),
    },
  },
  async ({ merchant_id, query, category }) => {
    try {
      const feed = await call<{
        merchant: unknown;
        products: { id: string; title: string; category: string }[];
      }>(`/api/feed/${encodeURIComponent(merchant_id)}`);

      const q = query?.trim().toLowerCase();
      const c = category?.trim().toLowerCase();
      const products = feed.products.filter((p) => {
        if (c !== undefined && c !== "" && p.category.toLowerCase() !== c) return false;
        if (q === undefined || q === "") return true;
        return p.title.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
      });

      return json({ merchant: feed.merchant, count: products.length, products });
    } catch (e) {
      return failure(e);
    }
  },
);

/* ---------------------------------------------------------------- mandates */

server.registerTool(
  "check_budget",
  {
    title: "Check a mandate's remaining authority",
    description:
      "How much of the human-signed envelope is left, the per-transaction cap, the threshold above " +
      "which a human must approve, and what the mandate is scoped to. Check this before quoting so " +
      "you ask for a basket that can actually be paid for.",
    inputSchema: {
      mandate_id: z.string().describe("e.g. mnd_household_weekly."),
    },
  },
  async ({ mandate_id }) => {
    try {
      return json(await call(`/api/agent/mandate/${encodeURIComponent(mandate_id)}`));
    } catch (e) {
      return failure(e);
    }
  },
);

/* ------------------------------------------------------------------- quote */

server.registerTool(
  "request_quote",
  {
    title: "Negotiate a cart",
    description:
      "Describe what you want in plain language. The merchant's agent proposes a cart and the gate " +
      "prices it. Returns the verdict, every rule that was evaluated with its observed value and " +
      "limit, and -- if allowed -- a priced cart with a single-use intent token. " +
      "You cannot name a price here; if you state one in the message it is treated as a preference, " +
      "not an instruction, and the gate still prices the cart itself.",
    inputSchema: {
      merchant_id: z.string(),
      mandate_id: z.string().describe("The budget envelope this purchase draws down."),
      message: z
        .string()
        .min(1)
        .describe("What you want, in a sentence. e.g. 'two cartons of oat milk and a box of tea'."),
    },
  },
  async ({ merchant_id, mandate_id, message }) => {
    try {
      const result = await call<{ outcome: string; cart?: { intent_token_id: string } }>(
        "/api/agent/quote",
        {
          method: "POST",
          body: JSON.stringify({
            merchant_id,
            mandate_id,
            message,
            holder_proof: proveHolder(mandate_id),
          }),
        },
      );

      const next =
        result.outcome === "ALLOW"
          ? "Call `pay` with the order_id, intent_token_id, mandate_id and session_id to settle."
          : result.outcome === "ALLOW_WITH_STEPUP"
            ? "A human must approve this. Give them the approval_url and stop here."
            : "Refused. Read `rules` for the rule that failed, then quote something within it.";

      return json({ ...result, next_step: next });
    } catch (e) {
      return failure(e);
    }
  },
);

/* --------------------------------------------------------------------- pay */

server.registerTool(
  "pay",
  {
    title: "Redeem an intent token",
    description:
      "Settle exactly one authorised cart. The token is single-use and expiring; a second call with " +
      "the same token is refused and creates no duplicate order. Never call this for a quote that " +
      "came back needing human approval.",
    inputSchema: {
      order_id: z.string(),
      intent_token_id: z.string().describe("From the quote that authorised this cart."),
      mandate_id: z.string().describe("The same mandate the quote drew down."),
      session_id: z
        .string()
        .optional()
        .describe(
          "The session_id from the same quote. Pass it so the whole transaction is one trace in the audit trail.",
        ),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ order_id, intent_token_id, mandate_id, session_id }) => {
    try {
      return json(await call("/api/agent/pay", {
        method: "POST",
        body: JSON.stringify({
          order_id,
          intent_token_id,
          session_id,
          holder_proof: proveHolder(mandate_id),
        }),
      }));
    } catch (e) {
      return failure(e);
    }
  },
);

/* ------------------------------------------------------------------- audit */

server.registerTool(
  "read_audit_trail",
  {
    title: "Read the audit trail",
    description:
      "Every decision made about you, in a hash-chained ledger, plus a live verification of the " +
      "chain. Pass a session_id from a quote to see only that negotiation.",
    inputSchema: {
      session_id: z.string().optional().describe("From a quote result. Omit for the whole ledger."),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ session_id, limit }) => {
    try {
      const params = new URLSearchParams();
      if (session_id !== undefined) params.set("session_id", session_id);
      if (limit !== undefined) params.set("limit", String(limit));
      const qs = params.toString();
      return json(await call(`/api/agent/audit${qs === "" ? "" : `?${qs}`}`));
    } catch (e) {
      return failure(e);
    }
  },
);

/* -------------------------------------------------------------------- boot */

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only: stdout is the protocol channel.
process.stderr.write(`mercury mcp ready, gateway ${BASE}\n`);
