import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { type CatalogItem, type MerchantProfile, cents, dollars } from "@mercury/core";
import { lowestLegalUnit, marginFloor } from "@mercury/gate";
import {
  DEFAULT_TIERS,
  basketValue,
  bulkTierUnit,
  bundleAddOn,
  nextTier,
  substituteFor,
  tierFor,
} from "./levers.js";

/**
 * The levers exist to raise basket value. These tests hold them to both halves
 * of that: they must actually raise it, and they must never do so by breaking a
 * limit the gate would then have to catch.
 */

const QUICK: MerchantProfile = {
  merchant_id: "mch_quick",
  display_name: "Corner Fresh Market",
  vertical: "quick_commerce",
  min_margin_bps: 1_500,
  max_discount_bps: 2_000,
  levers: ["bundle", "substitute"],
  category_taxonomy: ["staples", "beverages"],
};

const BULK: MerchantProfile = {
  merchant_id: "mch_bulk",
  display_name: "Harbor Wholesale Supply",
  vertical: "b2b_procurement",
  min_margin_bps: 800,
  max_discount_bps: 3_500,
  levers: ["bulk_tier", "substitute"],
  category_taxonomy: ["staples", "packaging"],
};

function item(over: Partial<CatalogItem> & { sku: string }): CatalogItem {
  return {
    merchant_id: "mch_quick",
    title: "Oat Milk 1L",
    category: "staples",
    unit: "bag",
    list_cents: dollars(600),
    cost_cents: dollars(400),
    stock: 40,
    moq: 1,
    ...over,
  };
}

function catalogOf(items: CatalogItem[]): ReadonlyMap<string, CatalogItem> {
  return new Map(items.map((i) => [i.sku, i]));
}

const QUICK_CATALOG = catalogOf([
  item({ sku: "QC_OATMILK_1L" }),
  item({
    sku: "QC_TEA_20CT",
    title: "Green Tea (20 bags)",
    category: "beverages",
    list_cents: dollars(250),
    cost_cents: dollars(150),
    stock: 100,
  }),
  item({
    sku: "QC_OLIVEOIL_500ML",
    title: "Olive Oil 500ml",
    list_cents: dollars(900),
    cost_cents: dollars(700),
    stock: 1,
  }),
  item({
    sku: "QC_BREAD_LOAF",
    title: "Sourdough Bread Loaf",
    list_cents: dollars(520),
    cost_cents: dollars(380),
    stock: 25,
  }),
]);

const BULK_CATALOG = catalogOf([
  item({
    sku: "WS_COFFEE_5LB",
    merchant_id: "mch_bulk",
    title: "Whole Bean Coffee 5lb",
    unit: "sack",
    list_cents: dollars(2_800),
    cost_cents: dollars(2_200),
    stock: 200,
    moq: 4,
  }),
]);

/* -------------------------------------------------------------- bulk tiers */

describe("bulk_tier", () => {
  it("gives a better unit price at a higher quantity", () => {
    const coffee = BULK_CATALOG.get("WS_COFFEE_5LB");
    if (coffee === undefined) throw new Error("unreachable");

    const small = bulkTierUnit(coffee, 4, BULK);
    const large = bulkTierUnit(coffee, 25, BULK);

    expect(large.unit).toBeLessThan(small.unit);
    expect(large.tier.discount_bps).toBeGreaterThan(small.tier.discount_bps);
  });

  it("raises basket value even though the unit price falls", () => {
    const coffee = BULK_CATALOG.get("WS_COFFEE_5LB");
    if (coffee === undefined) throw new Error("unreachable");

    const four = bulkTierUnit(coffee, 4, BULK).unit * 4;
    const ten = bulkTierUnit(coffee, 10, BULK).unit * 10;

    // The whole point of a tier: cheaper per sack, more dollars in the till.
    expect(ten).toBeGreaterThan(four);
  });

  it("clamps to the margin floor instead of breaching it", () => {
    // A SKU whose margin is thin enough that the deepest tier would go under.
    const thin = item({ sku: "THIN", list_cents: dollars(100), cost_cents: dollars(95) });
    const { unit, clamped } = bulkTierUnit(thin, 50, BULK);

    expect(clamped).toBe(true);
    expect(unit).toBeGreaterThanOrEqual(marginFloor(thin, BULK));
    expect(unit).toBeGreaterThanOrEqual(lowestLegalUnit(thin, BULK));
  });

  it("names the next rung so the agent has something to offer", () => {
    expect(nextTier(4)?.min_qty).toBe(5);
    expect(nextTier(10)?.min_qty).toBe(25);
    expect(nextTier(50)).toBeUndefined();
  });

  it("PROPERTY: no quantity produces a price below the floor", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 100, max: 50_000 }),
        fc.integer({ min: 1, max: 100 }),
        (qty, listCents, marginPct) => {
          const priced = item({
            sku: "P",
            list_cents: cents(listCents),
            cost_cents: cents(Math.floor(listCents / 2)),
          });
          const profile = { ...BULK, min_margin_bps: marginPct * 100 };
          const { unit } = bulkTierUnit(priced, qty, profile);
          return unit >= lowestLegalUnit(priced, profile);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("tierFor never goes backwards as quantity rises", () => {
    let last = -1;
    for (const qty of [1, 4, 5, 9, 10, 24, 25, 49, 50, 500]) {
      const bps = tierFor(qty, DEFAULT_TIERS).discount_bps;
      expect(bps).toBeGreaterThanOrEqual(last);
      last = bps;
    }
  });
});

/* ------------------------------------------------------------------ bundle */

describe("bundle", () => {
  it("suggests an add-on from a different category than the anchor", () => {
    const add = bundleAddOn(QUICK_CATALOG, QUICK, [
      { sku: "QC_OATMILK_1L", qty: 2, unit_cents: dollars(570) },
    ]);

    expect(add).toBeDefined();
    // The anchor is staples, so the add-on must not be.
    expect(QUICK_CATALOG.get(add?.sku ?? "")?.category).not.toBe("staples");
  });

  it("raises basket value", () => {
    const lines = [{ sku: "QC_OATMILK_1L", qty: 2, unit_cents: dollars(570) }];
    const before = 2 * dollars(570);
    const add = bundleAddOn(QUICK_CATALOG, QUICK, lines);
    if (add === undefined) throw new Error("expected a suggestion");

    expect(before + add.unit_cents * add.qty).toBeGreaterThan(before);
  });

  it("never prices the add-on below its own floor", () => {
    const add = bundleAddOn(QUICK_CATALOG, QUICK, [
      { sku: "QC_OATMILK_1L", qty: 2, unit_cents: dollars(570) },
    ]);
    if (add === undefined) throw new Error("expected a suggestion");
    const added = QUICK_CATALOG.get(add.sku);
    if (added === undefined) throw new Error("unreachable");

    expect(add.unit_cents).toBeGreaterThanOrEqual(lowestLegalUnit(added, QUICK));
  });

  it("stays an add-on rather than becoming a second basket", () => {
    const add = bundleAddOn(QUICK_CATALOG, QUICK, [
      { sku: "QC_TEA_20CT", qty: 1, unit_cents: dollars(200) },
    ]);
    if (add !== undefined) {
      expect(add.unit_cents * add.qty).toBeLessThanOrEqual(Math.floor(dollars(200) * 0.4));
    }
  });

  it("is silent for a merchant whose profile does not list the lever", () => {
    expect(
      bundleAddOn(BULK_CATALOG, BULK, [{ sku: "WS_COFFEE_5LB", qty: 4, unit_cents: dollars(2_600) }]),
    ).toBeUndefined();
  });

  it("never suggests something already in the cart", () => {
    const lines = [...QUICK_CATALOG.values()].map((i) => ({
      sku: i.sku,
      qty: 1,
      unit_cents: i.list_cents,
    }));
    expect(bundleAddOn(QUICK_CATALOG, QUICK, lines)).toBeUndefined();
  });
});

/* -------------------------------------------------------------- substitute */

describe("substitute", () => {
  it("swaps a short line for the nearest stocked equivalent", () => {
    // Olive oil has 1 in stock; asking for 3 cannot be filled.
    const swap = substituteFor(QUICK_CATALOG, QUICK, "QC_OLIVEOIL_500ML", 3);

    expect(swap).toBeDefined();
    expect(swap?.from_sku).toBe("QC_OLIVEOIL_500ML");
    expect(QUICK_CATALOG.get(swap?.to_sku ?? "")?.stock).toBeGreaterThanOrEqual(3);
  });

  it("does nothing when the line can be filled", () => {
    expect(substituteFor(QUICK_CATALOG, QUICK, "QC_OATMILK_1L", 2)).toBeUndefined();
  });

  it("never crosses into another category", () => {
    const swap = substituteFor(QUICK_CATALOG, QUICK, "QC_OLIVEOIL_500ML", 3);
    expect(QUICK_CATALOG.get(swap?.to_sku ?? "")?.category).toBe("staples");
  });

  it("is silent for a merchant whose profile does not list the lever", () => {
    const noSub: MerchantProfile = { ...QUICK, levers: ["bundle"] };
    expect(substituteFor(QUICK_CATALOG, noSub, "QC_OLIVEOIL_500ML", 3)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------- value */

describe("basketValue", () => {
  it("reports uplift against what the buyer asked for", () => {
    const v = basketValue(dollars(1_000), dollars(1_250), ["bundle"]);
    expect(v.uplift_cents).toBe(dollars(250));
    expect(v.uplift_bps).toBe(2_500);
    expect(v.levers_used).toEqual(["bundle"]);
  });

  it("reports a shortfall honestly rather than clamping to zero", () => {
    // A denied cart settles at zero. That is a real outcome, not a rounding case.
    const v = basketValue(dollars(1_000), cents(0), []);
    expect(v.uplift_cents).toBe(-dollars(1_000));
    expect(v.uplift_bps).toBe(-10_000);
  });
});
