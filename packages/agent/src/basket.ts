import type { Cents } from "@mercury/core";
import { mulP, cents, sumP } from "@mercury/core";
import type { NegotiatorContext } from "./negotiator.js";
import { priceFloor, searchCatalog } from "./tools.js";

/**
 * What the buyer asked for, and what it would ordinarily cost.
 *
 * This module exists because *both* negotiators need the same answer to the
 * same question, and they must not answer it differently. Uplift is baseline
 * versus approved; if the scripted agent and the LLM agent computed the
 * baseline by different means, the merchant console would be adding up two
 * incompatible measurements and calling the sum revenue.
 *
 * Nothing here decides a price that anyone pays. It reads the catalogue the
 * agent is allowed to see and produces a reference figure. The gate still prices
 * the cart that actually settles.
 */

/* ------------------------------------------------------- ordinary pricing -- */

/**
 * The discount an agent gives without pulling any lever.
 *
 * This is the counterfactual: the basket the buyer asked for, quoted the way it
 * would be quoted by an agent that had no levers at all. Every uplift figure in
 * the merchant console is measured against a basket priced at this rate, so it
 * is a constant rather than a per-agent choice.
 */
export const ORDINARY_DISCOUNT_BPS = 500;

/** List less the ordinary discount, never below the merchant's floor. */
export function ordinaryUnit(
  ctx: NegotiatorContext,
  sku: string,
  discountBps: number = ORDINARY_DISCOUNT_BPS,
): Cents {
  const [floor] = priceFloor(ctx, [sku]);
  if (floor === undefined) return cents(0);
  const discounted = floor.list_cents - Math.floor((floor.list_cents * discountBps) / 10_000);
  return cents(Math.max(discounted, floor.lowest_legal_unit_cents));
}

/**
 * The requested basket at ordinary pricing, with no lever applied.
 *
 * A SKU the merchant does not stock contributes nothing rather than throwing:
 * the baseline is a measurement, and a measurement that refuses to produce a
 * number is worse than one that ignores a line the gate would have refused too.
 */
export function ordinaryBasket(
  ctx: NegotiatorContext,
  want: readonly { sku: string; qty: number }[],
  discountBps: number = ORDINARY_DISCOUNT_BPS,
): Cents {
  return sumP(
    want.flatMap((w) => {
      const unit = ordinaryUnit(ctx, w.sku, discountBps);
      return unit === 0 ? [] : [mulP(unit, w.qty)];
    }),
  );
}

/* ---------------------------------------------------------- cart inference -- */

/**
 * Words that appear in a product title but do not identify a product.
 *
 * Packaging and size nouns are the trap: "a pack of tea" matched three
 * different SKUs before this list existed, because "pack" was in the title of
 * the granola and the pasta. A buyer naming a unit is describing how they want
 * it, not what they want.
 */
const NOT_A_PRODUCT = new Set([
  "pack", "packs", "bag", "bags", "bottle", "bottles", "tin", "tins", "sack",
  "sacks", "carton", "cartons", "case", "cases", "box", "boxes", "roll", "rolls",
  "jug", "jugs", "loaf", "loaves", "bunch", "bunches", "each", "the", "all",
  "and", "for", "with", "pure", "whole", "filter", "count", "size", "large",
  "small", "please", "some", "want", "need", "give", "order", "bean", "beans",
]);

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, fifteen: 15,
  twenty: 20, thirty: 30, fifty: 50, hundred: 100,
};

/** The words in a title that actually name the thing. */
function keywordsOf(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter((w) => w.length >= 3 && !NOT_A_PRODUCT.has(w));
}

function wordIndex(text: string, word: string): number {
  const m = new RegExp(`\\b${word}\\b`, "u").exec(text);
  return m?.index ?? -1;
}

/**
 * Infer a cart from free text.
 *
 * This is the seam where a sentence becomes a proposal, and it is deliberately
 * conservative: it will under-read a request rather than invent a line. Whatever
 * it produces is still only a *proposal* -- The gate reprices every line and checks
 * every limit -- so a misread here costs a round of negotiation, never money.
 */
export function inferCart(
  ctx: NegotiatorContext,
  message: string,
): { sku: string; qty: number }[] {
  const text = message.toLowerCase();
  const wanted: { sku: string; qty: number }[] = [];

  for (const item of searchCatalog(ctx, {})) {
    const skuAt = wordIndex(text, item.sku.toLowerCase());

    // Match on the most specific word first, so "oat milk" beats a bare "milk"
    // when both SKUs could plausibly answer.
    const keywords = keywordsOf(item.title).sort((a, b) => b.length - a.length);
    let at = skuAt;
    let matched = item.sku.toLowerCase();
    if (at < 0) {
      for (const w of keywords) {
        const i = wordIndex(text, w);
        if (i >= 0) {
          at = i;
          matched = w;
          break;
        }
      }
    }
    if (at < 0) continue;

    const qty = qtyNear(text, at, new Set([matched, ...keywords])) ?? item.moq;
    wanted.push({ sku: item.sku, qty: Math.max(qty, item.moq) });
  }
  return wanted;
}

/** Filler a quantity may sit behind without belonging to something else. */
const SKIPPABLE = new Set(["of", "x", "i", "need", "want", "please", "me", "us"]);

/**
 * The quantity attached to a mention.
 *
 * Scans backwards from the product word, stepping over this item's own title
 * words ("10 bags of whole bean coffee" must reach the 10) and over filler,
 * but stopping dead at a word belonging to a *different* product -- so in "two
 * cartons of oat milk and eight boxes of tea" the milk does not get the eight.
 */
function qtyNear(text: string, at: number, own: ReadonlySet<string>): number | undefined {
  const before = text.slice(Math.max(0, at - 40), at);
  const tokens = before.split(/[^a-z0-9]+/u).filter((t) => t !== "");

  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i];
    if (t === undefined) continue;

    if (/^\d+$/u.test(t)) {
      const n = Number.parseInt(t, 10);
      return Number.isSafeInteger(n) && n > 0 && n <= 5_000 ? n : undefined;
    }
    const spelled = WORD_NUMBERS[t];
    if (spelled !== undefined) return spelled;

    if (own.has(t) || NOT_A_PRODUCT.has(t) || SKIPPABLE.has(t)) continue;
    // A word that names something else. Its quantity is not ours.
    break;
  }
  return undefined;
}

/* -------------------------------------------------------------- invitation -- */

/**
 * Did the buyer invite an add-on?
 *
 * A bundle is the one lever that changes what is in the cart, so it needs
 * consent. An agent that silently appends a line to every basket is padding,
 * and would deserve to be caught doing it.
 */
const INVITATIONS =
  /\b(stock me up|top ?up|what else|anything else|weekly|restock|fill|usual|whatever you)\b/u;

export function invitesAddOns(message: string): boolean {
  return INVITATIONS.test(message.toLowerCase());
}

