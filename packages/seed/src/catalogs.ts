import { type CatalogItem, type MerchantProfile, dollars } from "@mercury/core";

/**
 * Two verticals, one gate.
 *
 * Everything that differs between B2C quick-commerce and B2B procurement lives
 * in this file and in prompts/. Gate, Ledger, the rail and the engine are
 * identical for both -- which is the architectural claim the demo makes.
 */

/* ------------------------------------------------- B2C quick-commerce ------ */

export const QUICK_COMMERCE: MerchantProfile = {
  merchant_id: "mch_quick",
  display_name: "Corner Fresh Market",
  vertical: "quick_commerce",
  // Thin retail margins: 15% over landed cost is the floor.
  min_margin_bps: 1_500,
  // Never more than 20% off list, whatever the agent negotiates.
  max_discount_bps: 2_000,
  levers: ["bundle", "substitute"],
  category_taxonomy: ["staples", "beverages", "snacks", "household"],
  /*
   * Order-shape limits, seeded deliberately loose.
   *
   * They exist so the merchant console has real values to show rather than a
   * board of blanks, and they are set wide enough that no seeded scenario
   * changes which rule denies it -- the F6 basket must still fail on the
   * mandate's per-transaction cap, not on this one. Tightening them until they
   * bite is the demo, not the seed.
   *
   * `reserve_units` is deliberately absent here: QC_OLIVEOIL_500ML is stocked at
   * 1 for the F3 inventory race, and any safety stock would make that row fail
   * on INVENTORY.RESERVE before it could ever reach the contention it tests.
   */
  max_order_cents: dollars(200),
  max_order_units: 200,
  max_order_lines: 12,
};

export const QUICK_COMMERCE_ITEMS: CatalogItem[] = [
  item("QC_OATMILK_1L", "Oat Milk 1L", "staples", "carton", 6.0, 4.0, 40),
  item("QC_BREAD_LOAF", "Sourdough Bread Loaf", "staples", "loaf", 5.2, 3.8, 25),
  item("QC_BANANAS", "Bananas (bunch)", "staples", "bunch", 1.8, 1.2, 8),
  item("QC_PASTA_500G", "Pasta 500g", "staples", "pack", 1.9, 1.4, 60),
  item("QC_TEA_20CT", "Green Tea (20 bags)", "beverages", "box", 2.5, 1.5, 100),
  item("QC_OJ_1L", "Orange Juice 1L", "beverages", "carton", 3.4, 2.3, 30),
  item("QC_GRANOLA_6PK", "Granola Bars (6-pack)", "snacks", "pack", 1.5, 0.95, 80),
  item("QC_DISHSOAP", "Dish Soap 500ml", "household", "bottle", 2.2, 1.5, 45),
  // Deliberately scarce: this is the SKU the F3 inventory race contends over.
  item("QC_OLIVEOIL_500ML", "Olive Oil 500ml", "staples", "bottle", 9.0, 7.0, 1),
];

/* ------------------------------------------------- B2B SME procurement ----- */

export const B2B_PROCUREMENT: MerchantProfile = {
  merchant_id: "mch_bulk",
  display_name: "Harbor Wholesale Supply",
  vertical: "b2b_procurement",
  // Wholesale runs thinner but sells volume: 8% floor.
  min_margin_bps: 800,
  // Bulk buyers can negotiate harder: up to 35% off list.
  max_discount_bps: 3_500,
  levers: ["bulk_tier", "credit_terms", "substitute"],
  category_taxonomy: ["staples", "beverages", "packaging"],
  /*
   * Above the mandate's own $1,500 per-transaction cap, on purpose: the
   * buyer's limit should still be the one that binds first on a seeded run, so
   * this reads as the merchant's separate ceiling rather than a duplicate of
   * the buyer's. Wholesale holds five units of everything back.
   */
  max_order_cents: dollars(2_000),
  max_order_units: 500,
  max_order_lines: 20,
  reserve_units: 5,
  /*
   * Wholesale is a multi-vendor floor: the buyer sees one cart and pays once,
   * and two different suppliers have to be paid out of it. Split settlement
   * does the dividing; the 2% commission comes off the top so a supplier's
   * share is never reduced by a fee it did not agree to.
   */
  settlement: {
    mode: "route",
    commission_bps: 200,
    commission_account_id: "acc_MERCURY_PLATFORM",
  },
};

/**
 * The connected accounts behind the wholesale catalogue.
 *
 * A payment provider issues ids like these once, per supplier, when the
 * supplier is onboarded. They are seed data rather than configuration because
 * which supplier sells which SKU is a fact about the catalogue.
 */
export const SUPPLIER_FOODS = "acc_HARBOR_FOODS";
export const SUPPLIER_PACKAGING = "acc_BAYSIDE_PACKAGING";

/*
 * Food comes from one supplier, packaging from another. A cart that crosses
 * both is the ordinary case in wholesale, and it is what makes the split
 * settlement worth having rather than a configuration flourish.
 */
export const B2B_ITEMS: CatalogItem[] = [
  item("WS_COFFEE_5LB", "Whole Bean Coffee 5lb", "beverages", "bag", 28.0, 22.0, 200, 4, SUPPLIER_FOODS),
  item("WS_FLOUR_50LB", "Bread Flour 50lb", "staples", "sack", 24.0, 19.5, 120, 2, SUPPLIER_FOODS),
  item("WS_OIL_35LB", "Canola Oil 35lb", "staples", "jug", 22.5, 18.0, 60, 2, SUPPLIER_FOODS),
  item("WS_OATMILK_12CT", "Oat Milk (12 x 1L case)", "beverages", "case", 51.0, 42.0, 40, 2, SUPPLIER_FOODS),
  item("WS_TEA_500CT", "Tea Bags (500 ct)", "beverages", "carton", 42.0, 34.0, 25, 1, SUPPLIER_FOODS),
  item("WS_CUPS_1000", "Paper Cups 12oz (1000 ct)", "packaging", "carton", 16.0, 12.5, 90, 5, SUPPLIER_PACKAGING),
  item("WS_NAPKINS_5000", "Napkins (5000 ct)", "packaging", "carton", 11.5, 9.0, 35, 2, SUPPLIER_PACKAGING),
];

/* ---------------------------------------------------------------- helper --- */

function item(
  sku: string,
  title: string,
  category: string,
  unit: string,
  listDollars: number,
  costDollars: number,
  stock: number,
  moq = 1,
  /** The connected account paid for this line. Absent means own inventory. */
  supplier?: string,
): CatalogItem {
  return {
    sku,
    merchant_id: sku.startsWith("WS_") ? "mch_bulk" : "mch_quick",
    title,
    category,
    unit,
    list_cents: dollars(listDollars),
    cost_cents: dollars(costDollars),
    stock,
    moq,
    ...(supplier === undefined ? {} : { supplier_account_id: supplier }),
  };
}

export const ALL_MERCHANTS = [QUICK_COMMERCE, B2B_PROCUREMENT];
export const ALL_ITEMS = [...QUICK_COMMERCE_ITEMS, ...B2B_ITEMS];
