import type { CatalogItem, Lever, MerchantProfile, Cents } from "@mercury/core";
import { mulP, cents, sumP } from "@mercury/core";
import { lowestLegalUnit } from "@mercury/gate";

/**
 * The revenue levers.
 *
 * This is the half of Mercury that exists to make the merchant *money* rather
 * than to stop the agent losing it. Everything here raises basket value; nothing
 * here decides whether the basket is allowed. The gate still reprices every line
 * afterwards, so a lever that produced an illegal price would be denied like any
 * other bad offer -- these functions clamp to the floor themselves so that never
 * happens, but the gate is the thing that guarantees it.
 *
 * Which levers a merchant may pull is `MerchantProfile.levers`. A lever the
 * profile does not list is not applied, which is how one implementation serves
 * both verticals: quick-commerce bundles and substitutes, wholesale runs bulk
 * tiers and substitutes, and no code branches on the vertical itself.
 */

/* --------------------------------------------------------------- bulk tier */

export interface BulkTier {
  /** Applies at this quantity and above. */
  min_qty: number;
  /** Discount off list, in basis points. */
  discount_bps: number;
}

/**
 * The default ladder.
 *
 * Deliberately shallow at the bottom and steep in the middle: the job is to
 * move a buyer from 4 units to 10, not to give away margin on a single unit.
 */
export const DEFAULT_TIERS: readonly BulkTier[] = [
  { min_qty: 1, discount_bps: 0 },
  { min_qty: 5, discount_bps: 600 },
  { min_qty: 10, discount_bps: 1_200 },
  { min_qty: 25, discount_bps: 1_800 },
  { min_qty: 50, discount_bps: 2_400 },
];

export function tierFor(qty: number, tiers: readonly BulkTier[] = DEFAULT_TIERS): BulkTier {
  let best: BulkTier = { min_qty: 1, discount_bps: 0 };
  for (const t of tiers) {
    if (qty >= t.min_qty && t.discount_bps >= best.discount_bps) best = t;
  }
  return best;
}

/** The next rung, if there is one -- what the agent offers the buyer to reach for. */
export function nextTier(
  qty: number,
  tiers: readonly BulkTier[] = DEFAULT_TIERS,
): BulkTier | undefined {
  return [...tiers].sort((a, b) => a.min_qty - b.min_qty).find((t) => t.min_qty > qty);
}

/**
 * Unit price at the tier the quantity earns, never below the merchant floor.
 *
 * The clamp is what makes a lever safe to hand to an agent: the deepest tier on
 * a thin-margin SKU simply stops at the floor rather than breaching it.
 */
export function bulkTierUnit(
  item: CatalogItem,
  qty: number,
  profile: MerchantProfile,
  tiers: readonly BulkTier[] = DEFAULT_TIERS,
): { unit: Cents; tier: BulkTier; clamped: boolean } {
  const tier = tierFor(qty, tiers);
  const floor = lowestLegalUnit(item, profile);
  const wanted = item.list_cents - Math.floor((item.list_cents * tier.discount_bps) / 10_000);
  const unit = Math.max(wanted, floor);
  return { unit: cents(unit), tier, clamped: unit > wanted };
}

/* ------------------------------------------------------------------ bundle */

export interface BundleSuggestion {
  sku: string;
  title: string;
  qty: number;
  unit_cents: Cents;
  list_cents: Cents;
  /** Why this item, in the merchant's voice. */
  reason: string;
}

/** Cart lines as the levers see them: enough to reason about, nothing more. */
export interface BasketLine {
  sku: string;
  qty: number;
  unit_cents: Cents;
}

/**
 * An add-on worth suggesting.
 *
 * Chosen from a *different* category than the basket's anchor, because the
 * point of a bundle is a trip the buyer would otherwise make twice -- not a
 * second unit of what they already have. Capped at a share of the basket so it
 * reads as an add-on rather than a second basket, which is the line between
 * bundling and padding.
 */
export function bundleAddOn(
  catalog: ReadonlyMap<string, CatalogItem>,
  profile: MerchantProfile,
  lines: readonly BasketLine[],
  opts: { maxShareBps?: number; sweetenerBps?: number } = {},
): BundleSuggestion | undefined {
  if (!profile.levers.includes("bundle")) return undefined;
  if (lines.length === 0) return undefined;

  const maxShare = opts.maxShareBps ?? 4_000;
  const sweetener = opts.sweetenerBps ?? 800;

  const basketTotal = sumP(lines.map((l) => mulP(l.unit_cents, l.qty)));
  if (basketTotal <= 0) return undefined;

  const inCart = new Set(lines.map((l) => l.sku));
  const anchorSku = [...lines].sort(
    (a, b) => mulP(b.unit_cents, b.qty) - mulP(a.unit_cents, a.qty),
  )[0]?.sku;
  const anchorCategory = anchorSku === undefined ? undefined : catalog.get(anchorSku)?.category;

  const ceiling = Math.floor((basketTotal * maxShare) / 10_000);

  let best: { item: CatalogItem; unit: Cents } | undefined;
  for (const item of [...catalog.values()].sort((a, b) => (a.sku < b.sku ? -1 : 1))) {
    if (inCart.has(item.sku)) continue;
    if (item.stock < item.moq) continue;
    if (anchorCategory !== undefined && item.category === anchorCategory) continue;

    const floor = lowestLegalUnit(item, profile);
    const wanted = item.list_cents - Math.floor((item.list_cents * sweetener) / 10_000);
    const unit = cents(Math.max(wanted, floor));
    if (mulP(unit, item.moq) > ceiling) continue;

    // The most valuable add-on that still fits under the cap.
    if (best === undefined || mulP(unit, item.moq) > mulP(best.unit, best.item.moq)) {
      best = { item, unit };
    }
  }

  if (best === undefined) return undefined;
  return {
    sku: best.item.sku,
    title: best.item.title,
    qty: best.item.moq,
    unit_cents: best.unit,
    list_cents: best.item.list_cents,
    reason: `ships in the same trip, ${(sweetener / 100).toFixed(0)}% off list when added to this basket`,
  };
}

/* -------------------------------------------------------------- substitute */

export interface Substitution {
  from_sku: string;
  to_sku: string;
  to_title: string;
  qty: number;
  unit_cents: Cents;
  reason: string;
}

/**
 * The nearest stocked equivalent when a line cannot be filled.
 *
 * Same category, enough stock, closest list price -- a substitution should be
 * recognisably the same purchase. Returns undefined rather than reaching into
 * another category, because a buyer who asked for oat milk does not want dish soap.
 */
export function substituteFor(
  catalog: ReadonlyMap<string, CatalogItem>,
  profile: MerchantProfile,
  sku: string,
  qty: number,
): Substitution | undefined {
  if (!profile.levers.includes("substitute")) return undefined;

  const wanted = catalog.get(sku);
  if (wanted === undefined) return undefined;
  if (wanted.stock >= qty) return undefined;

  let best: CatalogItem | undefined;
  for (const item of catalog.values()) {
    if (item.sku === sku) continue;
    if (item.category !== wanted.category) continue;
    if (item.stock < Math.max(qty, item.moq)) continue;
    if (
      best === undefined ||
      Math.abs(item.list_cents - wanted.list_cents) < Math.abs(best.list_cents - wanted.list_cents)
    ) {
      best = item;
    }
  }
  if (best === undefined) return undefined;

  const unit = cents(Math.max(best.list_cents, lowestLegalUnit(best, profile)));
  return {
    from_sku: sku,
    to_sku: best.sku,
    to_title: best.title,
    qty: Math.max(qty, best.moq),
    unit_cents: unit,
    reason: `${wanted.title} is short (${wanted.stock} left); this is the nearest stocked equivalent`,
  };
}

/* ------------------------------------------------------------------ metric */

/**
 * What the levers were worth.
 *
 * `baseline` is the basket the buyer literally asked for at ordinary pricing;
 * `final` is what the gate approved. The difference is the only honest measure
 * of whether the Revenue Agent earned its place, and it is recorded in the ledger
 * next to the decision so the claim is auditable rather than asserted.
 */
export interface BasketValue {
  baseline_cents: number;
  final_cents: number;
  uplift_cents: number;
  uplift_bps: number;
  levers_used: Lever[];
}

export function basketValue(
  baseline: Cents,
  final: Cents,
  levers: readonly Lever[],
): BasketValue {
  const uplift = final - baseline;
  return {
    baseline_cents: baseline,
    final_cents: final,
    uplift_cents: uplift,
    uplift_bps: baseline === 0 ? 0 : Math.round((uplift / baseline) * 10_000),
    levers_used: [...levers],
  };
}
