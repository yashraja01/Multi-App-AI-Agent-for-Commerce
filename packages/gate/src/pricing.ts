import {
  type CartLine,
  type CatalogItem,
  type MerchantProfile,
  type Cents,
  applyBpsCeil,
  bpsBelow,
  mulP,
  cents,
  sumP,
} from "@mercury/core";

/**
 * The margin floor for one SKU: the lowest unit price the merchant will accept.
 *
 *   floor = ceil( cost * (1 + min_margin_bps / 10000) )
 *
 * Rounding up means a floor can never be undershot by a rounding artefact.
 */
export function marginFloor(item: CatalogItem, profile: MerchantProfile): Cents {
  return applyBpsCeil(item.cost_cents, profile.min_margin_bps);
}

/** How many basis points below list a given offer sits. */
export function discountBps(item: CatalogItem, offerUnit: Cents): number {
  return bpsBelow(item.list_cents, offerUnit);
}

/**
 * The lowest unit price that satisfies BOTH the margin floor and the discount
 * ceiling. This is what auto-repair clamps a below-floor offer up to.
 */
export function lowestLegalUnit(item: CatalogItem, profile: MerchantProfile): Cents {
  const floor = marginFloor(item, profile);
  // Largest discount the merchant allows, expressed as a price.
  const discountLimited = cents(
    item.list_cents - Math.floor((item.list_cents * profile.max_discount_bps) / 10_000),
  );
  return floor >= discountLimited ? floor : discountLimited;
}

export interface PricedLineInput {
  item: CatalogItem;
  qty: number;
  unit: Cents;
}

/** Build a cart line. Pure arithmetic -- no policy decisions here. */
export function buildLine(input: PricedLineInput): CartLine {
  return {
    sku: input.item.sku,
    qty: input.qty,
    unit_cents: input.unit,
    list_cents: input.item.list_cents,
    line_total_cents: mulP(input.unit, input.qty),
  };
}

export interface CartTotals {
  subtotal_cents: Cents;
  discount_cents: Cents;
  total_cents: Cents;
}

/**
 * Total a set of lines.
 *
 * `subtotal` is what the cart would cost at list price; `total` is what it costs
 * at the negotiated price; `discount` is the difference. This is the arithmetic
 * that overrides whatever the model claimed the total was.
 */
export function totalLines(lines: readonly CartLine[]): CartTotals {
  const subtotal = sumP(lines.map((l) => mulP(l.list_cents, l.qty)));
  const total = sumP(lines.map((l) => l.line_total_cents));
  // An agent may legitimately price ABOVE list (a bundle premium, a rush fee),
  // in which case there is simply no discount. Clamping at zero keeps
  // discount_cents a non-negative Cents and stops a premium from crashing the
  // gate -- a gate that throws is strictly worse than a gate that denies.
  return {
    subtotal_cents: subtotal,
    discount_cents: cents(Math.max(0, subtotal - total)),
    total_cents: total,
  };
}
