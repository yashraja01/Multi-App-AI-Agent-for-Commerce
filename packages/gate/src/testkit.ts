import {
  type CatalogItem,
  type MerchantProfile,
  type Proposal,
  type BudgetMandate,
  type SignedBudgetMandate,
  generateKeyPair,
  mulP,
  cents,
  signValue,
  sumP,
} from "@mercury/core";
import type { GateInput, LedgerState } from "./evaluate.js";

/**
 * Deterministic fixtures for gate tests.
 *
 * Not exported from the package index -- this is a test aid, and keeping it out
 * of the public surface means production code cannot accidentally depend on it.
 */

export const KEYS = generateKeyPair();
/** The agent this fixture mandate delegates to. */
export const AGENT_KEYS = generateKeyPair();

export const PROFILE: MerchantProfile = {
  merchant_id: "mch_demo",
  display_name: "Demo Merchant",
  vertical: "quick_commerce",
  min_margin_bps: 1_500, // 15% over cost
  max_discount_bps: 2_000, // at most 20% off list
  levers: ["bundle", "substitute"],
  category_taxonomy: ["staples", "beverages"],
};

export const ITEMS: CatalogItem[] = [
  {
    sku: "SKU_RICE_5KG",
    merchant_id: "mch_demo",
    title: "Oat Milk 1L",
    category: "staples",
    unit: "bag",
    list_cents: cents(60_000), // $600
    cost_cents: cents(40_000), // $400 -> floor = 46000
    stock: 50,
    moq: 1,
  },
  {
    sku: "SKU_OIL_1L",
    merchant_id: "mch_demo",
    title: "Olive Oil 1L",
    category: "staples",
    unit: "bottle",
    list_cents: cents(18_000), // $180
    cost_cents: cents(12_000), // $120 -> floor = 13800
    stock: 8,
    moq: 2,
  },
  {
    sku: "SKU_TEA_250G",
    merchant_id: "mch_demo",
    title: "Green Tea (20 bags)",
    category: "beverages",
    unit: "pack",
    list_cents: cents(25_000),
    cost_cents: cents(15_000), // floor = 17250
    stock: 100,
    moq: 1,
  },
];

export function catalogOf(items: CatalogItem[] = ITEMS): ReadonlyMap<string, CatalogItem> {
  return new Map(items.map((i) => [i.sku, i]));
}

export const NOW = new Date("2026-06-01T10:00:00.000Z");

export function mandateOf(over: Partial<BudgetMandate> = {}): BudgetMandate {
  return {
    mandate_id: "mnd_test",
    principal_id: "prn_alice",
    agent_id: "agt_buyer",
    agent_public_key: AGENT_KEYS.publicKey,
    vertical: "quick_commerce",
    reserved_cents: cents(500_000), // $5,000 envelope
    max_per_txn_cents: cents(200_000), // $2,000 per txn
    max_txn_count: 10,
    requires_human_approval_above_cents: cents(150_000), // $1,500
    scope: {
      merchant_allowlist: ["mch_demo"],
      category_allowlist: ["staples", "beverages"],
    },
    human_present: false,
    not_before: "2026-01-01T00:00:00.000Z",
    expires_at: "2026-12-31T23:59:59.000Z",
    nonce: "nonce-test-1",
    ...over,
  };
}

export function signed(m: BudgetMandate = mandateOf()): SignedBudgetMandate {
  return { mandate: m, signature: signValue(m, KEYS.privateKey), public_key: KEYS.publicKey };
}

/** Build a proposal whose quoted total is arithmetically correct. */
export function proposalOf(
  lines: { sku: string; qty: number; offer_unit_cents: number }[],
  over: Partial<Proposal> = {},
): Proposal {
  const typed = lines.map((l) => ({
    sku: l.sku,
    qty: l.qty,
    offer_unit_cents: cents(l.offer_unit_cents),
  }));
  return {
    merchant_id: "mch_demo",
    lines: typed,
    quoted_total_cents: sumP(typed.map((l) => mulP(l.offer_unit_cents, l.qty))),
    rationale: "test proposal",
    ...over,
  };
}

export const CLEAN_LEDGER: LedgerState = { consumed_cents: cents(0), txn_count: 0 };

export function inputOf(over: Partial<GateInput> = {}): GateInput {
  return {
    signed_mandate: signed(),
    registered_public_key: KEYS.publicKey,
    profile: PROFILE,
    catalog: catalogOf(),
    proposal: proposalOf([{ sku: "SKU_RICE_5KG", qty: 1, offer_unit_cents: 55_000 }]),
    ledger_state: CLEAN_LEDGER,
    now: NOW,
    frozen: false,
    ...over,
  };
}
