import type { Lever, Cents, Proposal, RuleId } from "@mercury/core";
import { formatUSD, cents } from "@mercury/core";
import {
  type BundleSuggestion,
  type Substitution,
  basketValue,
  bulkTierUnit,
  bundleAddOn,
  substituteFor,
} from "./levers.js";
import type {
  Negotiator,
  NegotiationResult,
  NegotiationRound,
  NegotiationTurn,
  NegotiatorContext,
} from "./negotiator.js";
import { priceFloor, quoteTotal } from "./tools.js";
import {
  ORDINARY_DISCOUNT_BPS,
  inferCart,
  invitesAddOns,
  ordinaryBasket,
  ordinaryUnit,
} from "./basket.js";

/**
 * The Revenue Agent without the model.
 *
 * `FixtureRail` is to Stripe what this is to Claude (D10): the same interface,
 * a deterministic implementation, and the default everywhere correctness is
 * being asserted. Every test and all seven engineered failures run against this
 * agent, so the suite needs no API key, no network and no spend, and a run that
 * passes once passes identically forever.
 *
 * It is not a mock of the *system* -- it calls the same `searchCatalog` and
 * `priceFloor` implementations the model calls, submits a real `Proposal`
 * through the real gate, and re-quotes on a real denial. Only the judgement is
 * substituted.
 */

export interface ScriptedOptions {
  /** Discount to offer off list, in basis points. */
  discountBps?: number;
  /**
   * Offer this many cents per unit *below* the merchant's floor on the first
   * round -- an agent that caved to buyer pressure. This is the F1 injection.
   */
  underCutCents?: number;
  /**
   * Add this to the quoted total without changing the lines: the agent's
   * arithmetic disagreeing with the gate's. Always a hard DENY on drift.
   */
  driftCents?: number;
  /** What to buy. Omit to infer the cart from the buyer's message. */
  want?: readonly { sku: string; qty: number }[];
  /** Re-quote at the lowest legal price after a repairable denial. */
  reQuote?: boolean;
}

/**
 * What the merchant says when the gate refuses.
 *
 * A rule id is an operator's fact, not a sentence to read out to a customer.
 * The verdict panel and the ledger both carry the exact rule, the observed
 * value and the limit; the buyer gets a plain reason. These are fixed strings,
 * so nothing a model writes can end up standing in for a policy decision.
 */
const DECLINE_DEFAULT = "I cannot complete that. Let me know if you want a smaller basket.";

const DECLINE: Partial<Record<RuleId, string>> = {
  "MARGIN.FLOOR_BREACH":
    "That is below what we can sell it for. The price I quoted is the lowest we can do.",
  "DISCOUNT.BPS_CAP": "That discount is deeper than we are allowed to go on this line.",
  "DRIFT.AMOUNT_MISMATCH":
    "My total did not match the priced cart, so the offer was rejected before it could be charged. Nothing was taken.",
  "MANDATE.PER_TXN_CAP":
    "That basket is larger than a single transaction on your budget allows. Split it, or ask your human to raise the cap.",
  "MANDATE.ENVELOPE_REMAINING":
    "That exceeds what is left in your budget for this period.",
  "MANDATE.VELOCITY": "Your budget has no orders left in it for this period.",
  "MANDATE.EXPIRY": "Your budget authorisation has expired. Your human needs to issue a new one.",
  "MANDATE.SIGNATURE": "I could not verify your budget authorisation, so I cannot transact.",
  "INVENTORY.INSUFFICIENT": "Another buyer took the last of that stock while we were talking.",
  "CATALOG.UNKNOWN_SKU": "We do not stock that.",
  "CATALOG.BELOW_MOQ": "That is below the minimum order quantity for this line.",
  "SCOPE.MERCHANT_ALLOWLIST": "Your budget is not scoped to buy from us.",
  "SCOPE.CATEGORY_ALLOWLIST": "Your budget is not scoped to that category.",
  "TOKEN.REPLAY": "That authorisation has already been used.",
  "CIRCUIT.FROZEN": "Spending is frozen on our side right now. Nothing can be charged.",
};

/** The cart after the levers have been pulled, plus what pulling them cost. */
interface ShapedCart {
  want: { sku: string; qty: number }[];
  /** Per-SKU unit price a lever set. Absent means ordinary pricing. */
  units: Map<string, Cents>;
  used: Lever[];
  substitutions: Substitution[];
  /** An add-on the buyer was offered but did not invite. */
  suggestion?: BundleSuggestion;
}

export class ScriptedRevenueAgent implements Negotiator {
  readonly mode = "scripted" as const;
  readonly #ctx: NegotiatorContext;
  readonly #opts: ScriptedOptions;

  constructor(ctx: NegotiatorContext, opts: ScriptedOptions = {}) {
    this.#ctx = ctx;
    this.#opts = opts;
  }

  /** The discount this agent gives with no lever pulled. The uplift baseline. */
  #discountBps(): number {
    return this.#opts.discountBps ?? ORDINARY_DISCOUNT_BPS;
  }

  async negotiate(turn: NegotiationTurn): Promise<NegotiationResult> {
    const maxRounds = this.#ctx.maxRounds ?? 3;
    const asked = this.#opts.want ?? inferCart(this.#ctx, turn.buyer_message);
    const rounds: NegotiationRound[] = [];

    if (asked.length === 0) {
      return {
        reply: "We do not stock anything matching that. Tell me a category and I will quote.",
        rounds,
      };
    }

    // What the buyer literally asked for, priced ordinarily. This is the number
    // every lever is measured against.
    const baseline = ordinaryBasket(this.#ctx, asked, this.#discountBps());

    const shaped = this.#applyLevers(asked, turn.buyer_message);
    let proposal = this.#firstOffer(shaped.want, shaped.units);
    let settled: NegotiationRound | undefined;

    for (let round = 0; round < maxRounds; round += 1) {
      const feedback = await this.#ctx.submit(proposal);
      const entry: NegotiationRound = { proposal, feedback };
      rounds.push(entry);

      if (feedback.outcome !== "DENY") {
        settled = entry;
        break;
      }
      if (this.#opts.reQuote === false) break;

      const repaired = this.#reQuote(proposal);
      if (repaired === undefined) break;
      proposal = repaired;
    }

    const final = cents(
      settled?.feedback.computed_total_cents ?? settled?.proposal.quoted_total_cents ?? 0,
    );

    return {
      reply: this.#reply(settled, rounds, shaped),
      rounds,
      ...(settled === undefined ? {} : { settled }),
      ...(shaped.suggestion === undefined ? {} : { suggestion: shaped.suggestion }),
      ...(shaped.substitutions.length === 0 ? {} : { substitutions: shaped.substitutions }),
      value: basketValue(baseline, final, shaped.used),
    };
  }

  /**
   * Pull whichever levers the merchant profile allows.
   *
   * Order matters. Substitution first, because a line that cannot be filled has
   * to be fixed before it can be priced. Then bulk tiers on what remains. Then
   * a bundle add-on, which is the only lever that changes *what* is in the cart
   * and so is the only one gated on the buyer inviting it.
   */
  #applyLevers(
    asked: readonly { sku: string; qty: number }[],
    message: string,
  ): ShapedCart {
    const catalog = this.#ctx.catalog;
    const profile = this.#ctx.profile;
    const used: Lever[] = [];
    const substitutions: Substitution[] = [];
    const units = new Map<string, Cents>();

    // -- substitute ---------------------------------------------------------
    let want = asked.flatMap((w) => {
      const swap = substituteFor(catalog, profile, w.sku, w.qty);
      if (swap === undefined) return [w];
      substitutions.push(swap);
      if (!used.includes("substitute")) used.push("substitute");
      return [{ sku: swap.to_sku, qty: swap.qty }];
    });

    // -- bulk tier ----------------------------------------------------------
    if (profile.levers.includes("bulk_tier") && this.#opts.underCutCents === undefined) {
      for (const w of want) {
        const item = catalog.get(w.sku);
        if (item === undefined) continue;
        const { unit, tier } = bulkTierUnit(item, w.qty, profile);
        if (tier.discount_bps > 0) {
          units.set(w.sku, unit);
          if (!used.includes("bulk_tier")) used.push("bulk_tier");
        }
      }
    }

    // -- bundle -------------------------------------------------------------
    // Only when the buyer opened the door. Adding a line nobody asked for is
    // padding, and a padded cart is a bad-faith cart however good the price is.
    let suggestion: BundleSuggestion | undefined;
    if (this.#opts.underCutCents === undefined && this.#opts.want === undefined) {
      const lines = want.map((w) => ({
        sku: w.sku,
        qty: w.qty,
        unit_cents: units.get(w.sku) ?? ordinaryUnit(this.#ctx, w.sku, this.#discountBps()),
      }));
      suggestion = bundleAddOn(catalog, profile, lines);
      if (suggestion !== undefined && invitesAddOns(message)) {
        want = [...want, { sku: suggestion.sku, qty: suggestion.qty }];
        units.set(suggestion.sku, suggestion.unit_cents);
        if (!used.includes("bundle")) used.push("bundle");
        suggestion = undefined; // it is in the cart now, not a suggestion
      }
    }

    return { want, units, used, substitutions, ...(suggestion === undefined ? {} : { suggestion }) };
  }

  /** List price less the configured discount, floored at (or deliberately under) the merchant floor. */
  #firstOffer(
    want: readonly { sku: string; qty: number }[],
    units: ReadonlyMap<string, Cents>,
  ): Proposal {
    const floors = new Map(priceFloor(this.#ctx, want.map((w) => w.sku)).map((f) => [f.sku, f]));
    const discountBps = this.#discountBps();
    const underCut = this.#opts.underCutCents ?? 0;

    const lines = want.flatMap((w) => {
      const floor = floors.get(w.sku);
      if (floor === undefined) return [];
      const levered = units.get(w.sku);
      const discounted = floor.list_cents - Math.floor((floor.list_cents * discountBps) / 10_000);
      const unit =
        underCut > 0
          ? Math.max(0, floor.lowest_legal_unit_cents - underCut)
          : Math.max(levered ?? discounted, floor.lowest_legal_unit_cents);
      return [{ sku: w.sku, qty: w.qty, offer_unit_cents: cents(unit) }];
    });

    return {
      merchant_id: this.#ctx.profile.merchant_id,
      lines,
      quoted_total_cents: cents(quoteTotal(lines) + (this.#opts.driftCents ?? 0)),
      rationale:
        underCut > 0
          ? "Matching the price the buyer pushed for."
          : `Standard basket at ${discountBps / 100}% off list.`,
    };
  }

  /** Clamp every line up to the lowest price the merchant will legally accept. */
  #reQuote(previous: Proposal): Proposal | undefined {
    const floors = new Map(
      priceFloor(this.#ctx, previous.lines.map((l) => l.sku)).map((f) => [f.sku, f]),
    );
    let moved = false;
    const lines = previous.lines.map((l) => {
      const floor = floors.get(l.sku);
      if (floor === undefined) return l;
      if (l.offer_unit_cents >= floor.lowest_legal_unit_cents) return l;
      moved = true;
      return { ...l, offer_unit_cents: cents(floor.lowest_legal_unit_cents) };
    });

    const honestTotal = cents(quoteTotal(lines));
    const drifted = previous.quoted_total_cents !== cents(quoteTotal(previous.lines));
    if (!moved && !drifted) return undefined;

    return {
      merchant_id: previous.merchant_id,
      lines,
      quoted_total_cents: honestTotal,
      rationale: "Re-quoted at the lowest price we can legally accept.",
    };
  }

  #reply(
    settled: NegotiationRound | undefined,
    rounds: readonly NegotiationRound[],
    shaped: ShapedCart,
  ): string {
    if (settled === undefined) {
      const rule = rounds.at(-1)?.feedback.rule_ids[0];
      return DECLINE[rule ?? "MARGIN.FLOOR_BREACH"] ?? DECLINE_DEFAULT;
    }
    const total = settled.feedback.computed_total_cents ?? settled.proposal.quoted_total_cents;
    const items = settled.proposal.lines
      .map((l) => `${l.qty} x ${this.#ctx.catalog.get(l.sku)?.title ?? l.sku}`)
      .join(", ");
    const stepUp = settled.feedback.outcome === "ALLOW_WITH_STEPUP";

    const notes: string[] = [];
    for (const swap of shaped.substitutions) notes.push(swap.reason);
    if (shaped.used.includes("bulk_tier")) {
      notes.push("bulk pricing applied at this quantity");
    }
    if (shaped.used.includes("bundle")) {
      notes.push("added to the basket so it ships in one trip");
    }
    if (shaped.suggestion !== undefined) {
      notes.push(
        `you could add ${shaped.suggestion.qty} x ${shaped.suggestion.title} at ` +
          `${formatUSD(shaped.suggestion.unit_cents)} -- ${shaped.suggestion.reason}`,
      );
    }

    return (
      `${items} comes to ${formatUSD(cents(total))}. ` +
      (stepUp
        ? "That is above your approval threshold, so I have sent an approval link to your human. "
        : "Confirmed and ready to pay. ") +
      (notes.length === 0 ? "" : `(${notes.join("; ")}.)`)
    ).trim();
  }
}

/** The counterparty, without the model: a fixed adversarial script. */
export class ScriptedBuyerAgent {
  readonly #lines: readonly string[];
  #at = 0;

  constructor(lines: readonly string[]) {
    this.#lines = lines;
  }

  async respond(): Promise<string> {
    const line = this.#lines[Math.min(this.#at, this.#lines.length - 1)] ?? "";
    this.#at += 1;
    return line;
  }
}
