import { mercury } from "@/lib/mercury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A2A Agent Card.
 *
 * Discovery is a file, not a protocol: an agent that has never heard of this
 * merchant fetches one well-known URL and learns what it sells, how to talk to
 * it, and -- the part that matters here -- what it will refuse to do.
 *
 * We implement the AP2/A2A *shape* faithfully and claim no certification.
 */
export async function GET(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  const merchants = mercury().store.listMerchants();

  return Response.json(
    {
      protocol_version: "0.2",
      name: "Mercury",
      description:
        "The merchant side of agentic commerce. A buyer agent negotiates a cart with the " +
        "merchant's own agent; a deterministic policy gate decides whether any money may move.",
      url: origin,
      version: "0.1.0",
      provider: { organization: "Mercury", url: origin },

      capabilities: { streaming: true, push_notifications: false, state_transition_history: true },
      default_input_modes: ["text/plain", "application/json"],
      default_output_modes: ["application/json"],

      // How a buyer proves it is allowed to spend. Stated up front so an agent
      // knows before it starts that it cannot simply name a price.
      authorization: {
        model: "reserve_mandate",
        description:
          "A human-signed budget envelope (AP2 Intent-Mandate shaped): one block, many debits, " +
          "residual auto-released on close. Ed25519 over canonical JSON.",
        binds: ["merchant_allowlist", "category_allowlist", "per_transaction_cap", "velocity"],
        human_present_step_up: true,
        single_use_token: "intent_token",
      },

      // The honest part of the card.
      constraints: [
        "The buyer never sets a price. It sends a request; the merchant agent proposes and the gate prices.",
        "Every amount is an integer number of cents.",
        "A quoted total that disagrees with the gate's own total is refused outright.",
        "Spend above the mandate's approval threshold returns an approval link for a human, not a charge.",
      ],

      skills: [
        {
          id: "quote",
          name: "Negotiate a cart",
          description:
            "Describe what you want in plain language. Returns a priced cart, the gate's verdict, " +
            "and a single-use intent token if the cart was allowed.",
          tags: ["commerce", "negotiation"],
          input_modes: ["text/plain"],
          output_modes: ["application/json"],
        },
        {
          id: "pay",
          name: "Redeem an intent token",
          description: "Settle exactly one authorised cart. The token is single-use and expiring.",
          tags: ["payments"],
        },
        {
          id: "audit",
          name: "Read the audit trail",
          description:
            "Every decision, in a hash-chained ledger anyone can re-walk and verify independently.",
          tags: ["audit"],
        },
      ],

      merchants: merchants.map((m) => ({
        merchant_id: m.merchant_id,
        display_name: m.display_name,
        vertical: m.vertical,
        categories: m.category_taxonomy,
        feed: `${origin}/api/feed/${m.merchant_id}`,
      })),

      endpoints: {
        quote: `${origin}/api/agent/quote`,
        pay: `${origin}/api/agent/pay`,
        mandate: `${origin}/api/agent/mandate/{mandate_id}`,
        audit: `${origin}/api/agent/audit`,
      },

      settlement: { processor: "Stripe", mode: "test" },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
