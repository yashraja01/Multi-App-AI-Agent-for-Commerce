import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import * as z from "zod/v4";
import type { CatalogItem, Lever, Cents, Proposal } from "@mercury/core";
import { cents } from "@mercury/core";
import { lowestLegalUnit } from "@mercury/gate";
import {
  DEFAULT_TIERS,
  type BundleSuggestion,
  type Substitution,
  bulkTierUnit,
  bundleAddOn,
  nextTier,
  substituteFor,
} from "./levers.js";
import type { GateFeedback, NegotiatorContext } from "./negotiator.js";

/**
 * The shared tool surface.
 *
 * One set of tools serves both verticals -- quick-commerce and B2B procurement
 * differ only in the catalogue rows and the MerchantProfile numbers these tools
 * read. If a vertical ever needed a tool of its own, that would be the same
 * design bug as a vertical needing a branch inside Gate (D9).
 *
 * Every tool is `strict: true` with `additionalProperties: false`, so
 * `tool_use.input` is guaranteed to validate against the schema before our code
 * ever sees it. The Zod schema and the wire schema are the same object, which
 * is the point: there is no second, drifting definition of what an offer is.
 *
 * The implementations below are plain functions. `ScriptedRevenueAgent` calls
 * them directly and `LlmRevenueAgent` calls them through Claude, so both agents
 * see exactly the same view of the merchant.
 */

/* ------------------------------------------------------------------ views -- */

/**
 * What the agent is allowed to know about a SKU.
 *
 * `cost_cents` is deliberately absent. The agent negotiates against the floor,
 * not against the cost, so landed cost never enters a prompt and can never be
 * leaked to a buyer by a talkative model.
 */
export interface CatalogView {
  sku: string;
  title: string;
  category: string;
  unit: string;
  list_cents: number;
  stock: number;
  moq: number;
}

export interface FloorView {
  sku: string;
  list_cents: number;
  /** The lowest unit price that satisfies both the margin floor and the discount ceiling. */
  lowest_legal_unit_cents: number;
  max_discount_bps: number;
  stock: number;
  moq: number;
}

export function viewOf(item: CatalogItem): CatalogView {
  return {
    sku: item.sku,
    title: item.title,
    category: item.category,
    unit: item.unit,
    list_cents: item.list_cents,
    stock: item.stock,
    moq: item.moq,
  };
}

/* ------------------------------------------------- tool implementations ---- */

export interface SearchArgs {
  category?: string | undefined;
  query?: string | undefined;
}

/** Case-insensitive substring match on title and sku, optionally within a category. */
export function searchCatalog(ctx: NegotiatorContext, args: SearchArgs): CatalogView[] {
  const q = args.query?.trim().toLowerCase();
  const cat = args.category?.trim().toLowerCase();
  const out: CatalogView[] = [];
  for (const item of ctx.catalog.values()) {
    if (cat !== undefined && cat !== "" && item.category.toLowerCase() !== cat) continue;
    if (
      q !== undefined &&
      q !== "" &&
      !item.title.toLowerCase().includes(q) &&
      !item.sku.toLowerCase().includes(q)
    ) {
      continue;
    }
    out.push(viewOf(item));
  }
  // Stable order, so an identical request produces an identical prompt prefix.
  return out.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

/**
 * The floor for each requested SKU.
 *
 * This is the merchant telling its own agent where the line is, in advance --
 * which is why a below-floor offer is a genuine agent error rather than an
 * unavoidable one, and why F1 (parameter drift under buyer pressure) is a real
 * test of the gate rather than a rigged one.
 */
export function priceFloor(ctx: NegotiatorContext, skus: readonly string[]): FloorView[] {
  const out: FloorView[] = [];
  for (const sku of skus) {
    const item = ctx.catalog.get(sku);
    if (item === undefined) continue;
    out.push({
      sku: item.sku,
      list_cents: item.list_cents,
      lowest_legal_unit_cents: lowestLegalUnit(item, ctx.profile),
      max_discount_bps: ctx.profile.max_discount_bps,
      stock: item.stock,
      moq: item.moq,
    });
  }
  return out;
}

/** Sum a set of offer lines. The agent must do this itself; drift is checked against it. */
export function quoteTotal(lines: readonly { qty: number; offer_unit_cents: number }[]): number {
  return lines.reduce((sum, l) => sum + l.offer_unit_cents * l.qty, 0);
}

/* ---------------------------------------------------------- wire schemas --- */

export const zSearchInput = z.object({
  query: z.string().describe("Substring of a product title or SKU. Empty string means no filter."),
  category: z
    .string()
    .describe("Restrict to one category from the merchant taxonomy. Empty string means all."),
});

export const zFloorInput = z.object({
  skus: z.array(z.string()).min(1).describe("SKUs to price, exactly as returned by search_catalog."),
});

export const zOfferInput = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string().describe("A SKU from search_catalog. Never invent one."),
        qty: z.int().min(1).describe("Units. Must be at least the SKU minimum order quantity."),
        offer_unit_cents: z
          .int()
          .min(0)
          .describe("Offered price per unit, integer cents. Never below lowest_legal_unit_cents."),
      }),
    )
    .min(1),
  quoted_total_cents: z
    .int()
    .min(0)
    .describe("Your own arithmetic: sum of offer_unit_cents times qty. Checked against Gate."),
  rationale: z
    .string()
    .max(2000)
    .describe("One or two sentences on why this cart is good for the buyer and the merchant."),
});

export const zReplyInput = z.object({
  message: z.string().max(2000).describe("What to say back to the other agent."),
});

/* ------------------------------------------------------------- tool defs --- */

export type RunnableTool = BetaRunnableTool<any>;

/**
 * Force `strict: true` and `additionalProperties: false`.
 *
 * `betaZodTool` does not set these, and without them the model is free to send
 * an input that does not match the schema. For a tool whose arguments become
 * the amount of a payment, "usually valid" is not a category we accept.
 */
function harden<T>(tool: T): T {
  const schema = (tool as unknown as { input_schema: Record<string, unknown> }).input_schema;
  return {
    ...(tool as object),
    strict: true,
    input_schema: { ...schema, additionalProperties: false },
  } as T;
}

/** Captures what the model offered, so the caller can see it after the loop ends. */
export interface OfferSink {
  record(proposal: Proposal, feedback: GateFeedback): void;
  /** True once the gate has allowed an offer -- the loop should stop. */
  settled(): boolean;
  rounds(): number;
}

/**
 * Build the merchant agent's tools for one negotiation.
 *
 * The catalogue is reached through a tool rather than pasted into the prompt,
 * so the cached prefix (tools -> system -> messages) stays byte-identical
 * across turns and only the buyer's message varies.
 */
export function revenueTools(
  ctx: NegotiatorContext,
  sink: OfferSink,
  levers: LeverSink = NO_LEVERS,
): RunnableTool[] {
  const maxRounds = ctx.maxRounds ?? 3;

  const search = betaZodTool({
    name: "search_catalog",
    description:
      "List the SKUs this merchant actually sells, with list price, stock and minimum order " +
      "quantity. Call this before quoting anything. Never offer a SKU that this does not return.",
    inputSchema: zSearchInput,
    run: (args) => JSON.stringify(searchCatalog(ctx, args)),
  });

  const floor = betaZodTool({
    name: "price_floor",
    description:
      "The lowest unit price, in cents, that the merchant will legally accept for each SKU, plus " +
      "the discount ceiling, stock and MOQ. Offering below lowest_legal_unit_cents is a hard DENY.",
    inputSchema: zFloorInput,
    run: (args) => JSON.stringify(priceFloor(ctx, args.skus)),
  });

  const offer = betaZodTool({
    name: "submit_offer",
    description:
      "Put a cart through the gate, the policy gate. Returns the verdict: ALLOW, ALLOW_WITH_STEPUP " +
      "or DENY with the rule that failed, the observed value and the limit. On DENY, fix the " +
      "offer and submit again. All amounts are integer cents.",
    inputSchema: zOfferInput,
    run: async (args) => {
      if (sink.settled()) {
        return JSON.stringify({
          outcome: "REJECTED",
          reason: "This turn is already settled. Reply to the buyer instead of offering again.",
        });
      }
      if (sink.rounds() >= maxRounds) {
        return JSON.stringify({
          outcome: "REJECTED",
          reason: `Round limit (${maxRounds}) reached. Explain the position to the buyer and stop.`,
        });
      }
      const proposal = {
        merchant_id: ctx.profile.merchant_id,
        lines: args.lines.map((l) => ({
          sku: l.sku,
          qty: l.qty,
          offer_unit_cents: l.offer_unit_cents,
        })),
        quoted_total_cents: args.quoted_total_cents,
        rationale: args.rationale,
      } as Proposal;
      const feedback = await ctx.submit(proposal);
      sink.record(proposal, feedback);
      return JSON.stringify(feedback);
    },
  });

  // Order is fixed: catalogue, then floor, then the levers, then the gate. The
  // tool block is the head of the cached prefix, so it must not vary per turn.
  return [search, floor, ...leverTools(ctx, levers), offer].map(harden);
}

/** The buyer agent's single tool: say something back. */
export function buyerTools(capture: (message: string) => void): RunnableTool[] {
  const reply = betaZodTool({
    name: "send_message",
    description: "Send one short paragraph to the merchant's agent.",
    inputSchema: zReplyInput,
    run: (args) => {
      capture(args.message);
      return "delivered";
    },
  });
  return [reply].map(harden);
}

/* ------------------------------------------------------------ lever tools -- */

/**
 * What the model actually pulled.
 *
 * The scripted agent applies levers itself and therefore knows what it used.
 * The model decides for itself, so the only way to attribute uplift honestly is
 * to record what it asked for and check it against the cart that settled --
 * which is what `LeverSink` is for. A lever the model merely *looked at* is not
 * a lever it used, and the merchant console must not be told otherwise.
 */
export interface TierQuote {
  sku: string;
  qty: number;
  unit_cents: Cents;
  discount_bps: number;
}

export interface LeverSink {
  /** A bulk-tier price the model was quoted for a SKU at a quantity. */
  tier(q: TierQuote): void;
  /** An add-on the model was offered. Whether it entered the cart is checked later. */
  bundle(s: BundleSuggestion): void;
  /** A swap the model was offered for a line it could not fill. */
  substitute(s: Substitution): void;
}

/** A sink that records nothing, for callers that only want the catalogue tools. */
export const NO_LEVERS: LeverSink = {
  tier: () => undefined,
  bundle: () => undefined,
  substitute: () => undefined,
};

export const zTierInput = z.object({
  sku: z.string().describe("A SKU from search_catalog."),
  qty: z.int().min(1).describe("The quantity the buyer is considering."),
});

export const zBundleInput = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string(),
        qty: z.int().min(1),
        unit_cents: z.int().min(0).describe("The unit price you intend to offer, integer cents."),
      }),
    )
    .min(1)
    .describe("The cart as it stands. The add-on is chosen to complement it."),
});

export const zSubstituteInput = z.object({
  sku: z.string().describe("The SKU the buyer asked for."),
  qty: z.int().min(1).describe("How many they want."),
});

/**
 * The three revenue levers, as tools.
 *
 * These are the same functions the scripted agent calls (`levers.ts`), exposed
 * so the model can reach them. Without this the LLM path has no mechanism for
 * Goal 1 at all and falls back to a flat discount, which is not a revenue agent
 * -- it is a coupon.
 *
 * Every one of them is present for every merchant, with the same schema, so the
 * cached tool prefix does not fork per merchant (D9: one tool set, only the data
 * behind it differs). A lever the profile does not permit answers `available:
 * false` and returns nothing to price with. The permission check lives in
 * `levers.ts`, so it is the same check the scripted agent passes through.
 */
function leverTools(ctx: NegotiatorContext, levers: LeverSink): RunnableTool[] {
  const permits = (l: Lever): boolean => ctx.profile.levers.includes(l);
  const denied = (l: Lever): string =>
    JSON.stringify({ available: false, reason: `this merchant does not permit the ${l} lever` });

  const tier = betaZodTool({
    name: "bulk_tier_quote",
    description:
      "The quantity-ladder price for a SKU: the discount this quantity earns, the unit price it " +
      "implies, and the next rung up with the quantity needed to reach it. The price returned is " +
      "already clamped to the merchant floor, so it is always safe to offer. Use this to move a " +
      "buyer up a rung rather than discounting a quantity they already chose.",
    inputSchema: zTierInput,
    run: (args) => {
      if (!permits("bulk_tier")) return denied("bulk_tier");
      const item = ctx.catalog.get(args.sku);
      if (item === undefined) {
        return JSON.stringify({ available: false, reason: `unknown sku: ${args.sku}` });
      }
      const { unit, tier: earned, clamped } = bulkTierUnit(item, args.qty, ctx.profile);
      levers.tier({ sku: item.sku, qty: args.qty, unit_cents: unit, discount_bps: earned.discount_bps });
      const next = nextTier(args.qty);
      const upgrade =
        next === undefined ? undefined : bulkTierUnit(item, next.min_qty, ctx.profile);
      return JSON.stringify({
        available: true,
        sku: item.sku,
        qty: args.qty,
        list_cents: item.list_cents,
        unit_cents: unit,
        discount_bps: earned.discount_bps,
        // True when the ladder wanted to go deeper than the merchant floor allows.
        // The deeper rung is then worth nothing, and offering it is a lie.
        clamped_to_floor: clamped,
        ladder: DEFAULT_TIERS,
        ...(next === undefined || upgrade === undefined
          ? {}
          : {
              next_tier: {
                min_qty: next.min_qty,
                discount_bps: next.discount_bps,
                unit_cents: upgrade.unit,
                units_to_go: next.min_qty - args.qty,
              },
            }),
      });
    },
  });

  const bundle = betaZodTool({
    name: "suggest_bundle",
    description:
      "One add-on worth offering alongside this cart: a different category from the cart's " +
      "anchor, in stock, capped at a share of the basket. Returns whether the buyer's own " +
      "message invited an add-on. If it did not, you may MENTION the item but must NOT put it " +
      "in submit_offer -- a line the buyer never asked for is padding, not revenue.",
    inputSchema: zBundleInput,
    run: (args) => {
      if (!permits("bundle")) return denied("bundle");
      const lines = args.lines.map((l) => ({
        sku: l.sku,
        qty: l.qty,
        unit_cents: cents(l.unit_cents),
      }));
      const found = bundleAddOn(ctx.catalog, ctx.profile, lines);
      if (found === undefined) {
        return JSON.stringify({ available: true, suggestion: null, reason: "nothing fits this cart" });
      }
      levers.bundle(found);
      return JSON.stringify({
        available: true,
        invited: ctx.invited === true,
        suggestion: found,
      });
    },
  });

  const substitute = betaZodTool({
    name: "find_substitute",
    description:
      "The nearest stocked equivalent when a line cannot be filled: same category, enough stock, " +
      "closest list price. Returns nothing if the SKU can be filled as asked, or if no equivalent " +
      "exists. Never offer an item from another category as a substitute.",
    inputSchema: zSubstituteInput,
    run: (args) => {
      if (!permits("substitute")) return denied("substitute");
      const found = substituteFor(ctx.catalog, ctx.profile, args.sku, args.qty);
      if (found === undefined) {
        const item = ctx.catalog.get(args.sku);
        return JSON.stringify({
          available: true,
          substitution: null,
          reason:
            item === undefined
              ? `unknown sku: ${args.sku}`
              : item.stock >= args.qty
                ? "this line can be filled as asked"
                : "no stocked equivalent in the same category",
        });
      }
      levers.substitute(found);
      return JSON.stringify({ available: true, substitution: found });
    },
  });

  return [tier, bundle, substitute];
}
