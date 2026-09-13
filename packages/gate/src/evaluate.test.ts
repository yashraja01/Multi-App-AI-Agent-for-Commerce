import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { type RuleId, generateKeyPair, cents, signValue } from "@mercury/core";
import { evaluate } from "./evaluate.js";
import { marginFloor } from "./pricing.js";
import { repairProposal } from "./repair.js";
import {
  ITEMS,
  KEYS,
  PROFILE,
  catalogOf,
  inputOf,
  mandateOf,
  proposalOf,
  signed,
} from "./testkit.js";

/** Assert a DENY carrying a specific rule, and return the violation for inspection. */

function expectDeny(d: ReturnType<typeof evaluate>, rule: RuleId) {
  expect(d.outcome).toBe("DENY");
  if (d.outcome !== "DENY") throw new Error("unreachable");
  expect(d.violation.rule_id).toBe(rule);
  expect(d.violation.passed).toBe(false);
  return d.violation;
}

describe("Gate happy path", () => {

  it("allows a clean proposal and returns a cart it computed itself", () => {
    const d = evaluate(inputOf());
    expect(d.outcome).toBe("ALLOW");
    if (d.outcome === "DENY") throw new Error("unreachable");
    expect(d.computed_cents).toBe(55_000);
    expect(d.cart.lines).toHaveLength(1);
    expect(d.cart.subtotal_cents).toBe(60_000); // list
    expect(d.cart.discount_cents).toBe(5_000);
    expect(d.cart.total_cents).toBe(55_000);
  });

  it("records a passing evaluation for every rule it checked", () => {
    const d = evaluate(inputOf());
    const ids = new Set(d.rules.map((r) => r.rule_id));
    // Every rule should be represented on a clean pass, including the five
    // merchant-side limits this profile leaves unset -- a limit nobody set is
    // still a limit that was considered, and the rule list is the evidence.
    expect(ids.size).toBe(20);
    expect(d.rules.every((r) => r.passed)).toBe(true);
  });

  it("totals multiple lines correctly", () => {
    const d = evaluate(
      inputOf({
        proposal: proposalOf([
          { sku: "SKU_RICE_5KG", qty: 2, offer_unit_cents: 55_000 },
          { sku: "SKU_TEA_250G", qty: 1, offer_unit_cents: 22_000 },
        ]),
      }),
    );
    expect(d.outcome).toBe("ALLOW");
    if (d.outcome === "DENY") throw new Error("unreachable");
    expect(d.computed_cents).toBe(132_000);
  });
});

describe("Gate rule coverage -- every rule can deny", () => {

  it("CIRCUIT.FROZEN short-circuits everything", () => {
    const v = expectDeny(evaluate(inputOf({ frozen: true })), "CIRCUIT.FROZEN");
    expect(v.message).toMatch(/frozen/i);
  });

  it("MANDATE.SIGNATURE rejects a mandate edited after signing", () => {
    const m = mandateOf();
    const sig = signValue(m, KEYS.privateKey);
    // Attacker inflates the envelope but keeps the original signature.
    const tampered = { ...m, reserved_cents: cents(99_999_999) };
    const d = evaluate(
      inputOf({
        signed_mandate: { mandate: tampered, signature: sig, public_key: KEYS.publicKey },
      }),
    );
    const v = expectDeny(d, "MANDATE.SIGNATURE");
    expect(v.message).toMatch(/altered after signing/);
  });

  it("MANDATE.SIGNATURE rejects a key not registered to the principal", () => {
    const rogue = generateKeyPair();
    const m = mandateOf();
    const d = evaluate(
      inputOf({
        signed_mandate: {
          mandate: m,
          signature: signValue(m, rogue.privateKey),
          public_key: rogue.publicKey,
        },
      }),
    );
    const v = expectDeny(d, "MANDATE.SIGNATURE");
    expect(v.message).toMatch(/not registered/);
  });

  it("MANDATE.EXPIRY rejects an expired mandate", () => {
    const d = evaluate(
      inputOf({ signed_mandate: signed(mandateOf({ expires_at: "2026-05-01T00:00:00.000Z" })) }),
    );
    expectDeny(d, "MANDATE.EXPIRY");
  });

  it("MANDATE.EXPIRY rejects a not-yet-valid mandate", () => {
    const d = evaluate(
      inputOf({ signed_mandate: signed(mandateOf({ not_before: "2026-07-01T00:00:00.000Z" })) }),
    );
    expectDeny(d, "MANDATE.EXPIRY");
  });

  it("SCOPE.MERCHANT_ALLOWLIST rejects an off-list merchant", () => {
    const d = evaluate(
      inputOf({
        signed_mandate: signed(
          mandateOf({
            scope: { merchant_allowlist: ["mch_other"], category_allowlist: ["staples"] },
          }),
        ),
      }),
    );
    expectDeny(d, "SCOPE.MERCHANT_ALLOWLIST");
  });

  it("SCOPE.CATEGORY_ALLOWLIST rejects an off-list category", () => {
    const d = evaluate(
      inputOf({
        signed_mandate: signed(
          mandateOf({
            scope: { merchant_allowlist: ["mch_demo"], category_allowlist: ["staples"] },
          }),
        ),
        proposal: proposalOf([{ sku: "SKU_TEA_250G", qty: 1, offer_unit_cents: 22_000 }]),
      }),
    );
    const v = expectDeny(d, "SCOPE.CATEGORY_ALLOWLIST");
    expect(v.message).toMatch(/beverages/);
  });

  it("CATALOG.UNKNOWN_SKU rejects a SKU the merchant does not sell", () => {
    const d = evaluate(
      inputOf({ proposal: proposalOf([{ sku: "SKU_NOPE", qty: 1, offer_unit_cents: 1_000 }]) }),
    );
    expectDeny(d, "CATALOG.UNKNOWN_SKU");
  });

  it("CATALOG.BELOW_MOQ enforces minimum order quantity", () => {
    const d = evaluate(
      inputOf({ proposal: proposalOf([{ sku: "SKU_OIL_1L", qty: 1, offer_unit_cents: 16_000 }]) }),
    );
    const v = expectDeny(d, "CATALOG.BELOW_MOQ");
    expect(v.observed).toBe(1);
    expect(v.limit).toBe(2);
  });

  it("INVENTORY.INSUFFICIENT rejects an over-order", () => {
    const d = evaluate(
      inputOf({ proposal: proposalOf([{ sku: "SKU_OIL_1L", qty: 99, offer_unit_cents: 16_000 }]) }),
    );
    const v = expectDeny(d, "INVENTORY.INSUFFICIENT");
    expect(v.observed).toBe(8);
    expect(v.limit).toBe(99);
  });

  it("MARGIN.FLOOR_BREACH rejects a price below cost plus minimum margin", () => {
    // milk cost 40000, min margin 1500bps -> floor 46000
    const d = evaluate(
      inputOf({ proposal: proposalOf([{ sku: "SKU_RICE_5KG", qty: 1, offer_unit_cents: 45_999 }]) }),
    );
    const v = expectDeny(d, "MARGIN.FLOOR_BREACH");
    expect(v.observed).toBe(45_999);
    expect(v.limit).toBe(46_000);
  });

  it("DISCOUNT.BPS_CAP rejects a discount past the ceiling even when margin is fine", () => {
    // A profile where the floor is low enough that discount is the binding rule.
    const generous = { ...PROFILE, min_margin_bps: 0, max_discount_bps: 1_000 };
    const d = evaluate(
      inputOf({
        profile: generous,
        proposal: proposalOf([{ sku: "SKU_RICE_5KG", qty: 1, offer_unit_cents: 50_000 }]),
      }),
    );
    const v = expectDeny(d, "DISCOUNT.BPS_CAP");
    expect(v.observed).toBeGreaterThan(1_000);
    expect(v.limit).toBe(1_000);
  });

  it("DRIFT.AMOUNT_MISMATCH is the zero-hallucinated-transaction guarantee", () => {
    const p = proposalOf([{ sku: "SKU_RICE_5KG", qty: 2, offer_unit_cents: 55_000 }]);
    // The model claims a total it did not derive from the lines.
    const lying = { ...p, quoted_total_cents: cents(55_000) };
    const v = expectDeny(evaluate(inputOf({ proposal: lying })), "DRIFT.AMOUNT_MISMATCH");
    expect(v.observed).toBe(55_000);
    expect(v.limit).toBe(110_000);
    expect(v.message).toMatch(/discarded/);
  });

  it("MANDATE.PER_TXN_CAP rejects a cart over the single-transaction ceiling", () => {
    const d = evaluate(
      inputOf({
        signed_mandate: signed(mandateOf({ max_per_txn_cents: cents(50_000) })),
        proposal: proposalOf([{ sku: "SKU_RICE_5KG", qty: 1, offer_unit_cents: 55_000 }]),
      }),
    );
    const v = expectDeny(d, "MANDATE.PER_TXN_CAP");
    expect(v.observed).toBe(55_000);
    expect(v.limit).toBe(50_000);
  });

  it("MANDATE.ENVELOPE_REMAINING rejects a drawdown past the reserve", () => {
    const d = evaluate(
      inputOf({
        signed_mandate: signed(mandateOf({ reserved_cents: cents(60_000) })),
        ledger_state: { consumed_cents: cents(50_000), txn_count: 1 },
      }),
    );
    const v = expectDeny(d, "MANDATE.ENVELOPE_REMAINING");
    expect(v.observed).toBe(55_000);
    expect(v.limit).toBe(10_000); // remaining
  });

  it("MANDATE.VELOCITY rejects more debits than the mandate permits", () => {
    const d = evaluate(
      inputOf({
        signed_mandate: signed(mandateOf({ max_txn_count: 3 })),
        ledger_state: { consumed_cents: cents(0), txn_count: 3 },
      }),
    );
    const v = expectDeny(d, "MANDATE.VELOCITY");
    expect(v.observed).toBe(4);
    expect(v.limit).toBe(3);
  });

  it("TOKEN.REPLAY rejects a token that was already spent", () => {
    const token = {
      token_id: "itk_used",
      mandate_id: "mnd_test",
      cart_hash: "a".repeat(64),
      amount_cents: cents(55_000),
      nonce: "n1",
      issued_at: "2026-06-01T09:59:00.000Z",
      expires_at: "2026-06-01T10:05:00.000Z",
    };
    const d = evaluate(
      inputOf({ intent_token: token, spent_token_ids: new Set(["itk_used"]) }),
    );
    expectDeny(d, "TOKEN.REPLAY");
  });

  it("TOKEN.REPLAY rejects an expired token", () => {
    const token = {
      token_id: "itk_old",
      mandate_id: "mnd_test",
      cart_hash: "a".repeat(64),
      amount_cents: cents(55_000),
      nonce: "n2",
      issued_at: "2026-06-01T09:00:00.000Z",
      expires_at: "2026-06-01T09:05:00.000Z", // before NOW
    };
    const d = evaluate(inputOf({ intent_token: token, spent_token_ids: new Set() }));
    const v = expectDeny(d, "TOKEN.REPLAY");
    expect(v.message).toMatch(/expired/);
  });
});

describe("Gate step-up -- human in the loop", () => {

  it("requires step-up at or above the approval threshold", () => {
    const d = evaluate(
      inputOf({ proposal: proposalOf([{ sku: "SKU_RICE_5KG", qty: 3, offer_unit_cents: 55_000 }]) }),
    );
    expect(d.outcome).toBe("ALLOW_WITH_STEPUP");
    if (d.outcome !== "ALLOW_WITH_STEPUP") throw new Error("unreachable");
    // mandate.human_present is false in the fixture
    expect(d.step_up).toBe("HUMAN_NOT_PRESENT_HIGH_VALUE");
    expect(d.computed_cents).toBe(165_000);
  });

  it("labels the step-up differently when a human is already present", () => {
    const d = evaluate(
      inputOf({
        signed_mandate: signed(mandateOf({ human_present: true })),
        proposal: proposalOf([{ sku: "SKU_RICE_5KG", qty: 3, offer_unit_cents: 55_000 }]),
      }),
    );
    expect(d.outcome).toBe("ALLOW_WITH_STEPUP");
    if (d.outcome !== "ALLOW_WITH_STEPUP") throw new Error("unreachable");
    expect(d.step_up).toBe("ABOVE_HUMAN_APPROVAL_THRESHOLD");
  });

  it("does not require step-up below the threshold", () => {
    expect(evaluate(inputOf()).outcome).toBe("ALLOW");
  });
});

describe("the gate is pure", () => {

  it("returns the same decision for the same inputs", () => {
    const a = evaluate(inputOf());
    const b = evaluate(inputOf());
    expect(a.outcome).toBe(b.outcome);
    expect(a.rules).toEqual(b.rules);
  });

  it("does not mutate its inputs", () => {
    const input = inputOf();
    const before = JSON.stringify({ p: input.proposal, l: input.ledger_state });
    evaluate(input);
    expect(JSON.stringify({ p: input.proposal, l: input.ledger_state })).toBe(before);
  });
});

/* ------------------------------------------------------------ the M2 gate ---- */

describe("PROPERTY: no input can produce spend beyond the mandate", () => {
  const skus = ITEMS.map((i) => i.sku);
  const arbProposal = fc
    .array(
      fc.record({
        sku: fc.constantFrom(...skus),
        qty: fc.integer({ min: 1, max: 12 }),
        offer_unit_cents: fc.integer({ min: 0, max: 120_000 }),
      }),
      { minLength: 1, maxLength: 4 },
    )
    .map((lines) => proposalOf(lines));
  const arbLedger = fc.record({
    consumed_cents: fc.integer({ min: 0, max: 600_000 }).map((n) => cents(n)),
    txn_count: fc.integer({ min: 0, max: 12 }),
  });
  const arbMandateShape = fc.record({
    reserved_cents: fc.integer({ min: 0, max: 800_000 }).map((n) => cents(n)),
    max_per_txn_cents: fc.integer({ min: 0, max: 400_000 }).map((n) => cents(n)),
    max_txn_count: fc.integer({ min: 1, max: 12 }),
  });

  it("an approved cart never exceeds the remaining envelope, the per-txn cap, or the velocity limit", () => {
    fc.assert(
      fc.property(arbProposal, arbLedger, arbMandateShape, (proposal, ledger, shape) => {
        const mandate = mandateOf(shape);
        const d = evaluate(
          inputOf({ signed_mandate: signed(mandate), proposal, ledger_state: ledger }),
        );
        if (d.outcome === "DENY") return true; // denials are always safe
        const total = d.computed_cents;
        const remaining = mandate.reserved_cents - ledger.consumed_cents;
        return (
          total <= remaining &&
          total <= mandate.max_per_txn_cents &&
          ledger.txn_count + 1 <= mandate.max_txn_count &&
          total === d.cart.total_cents
        );
      }),
      { numRuns: 2000 },
    );
  });

  it("an approved cart never prices any line below its margin floor", () => {
    fc.assert(
      fc.property(arbProposal, (proposal) => {
        const d = evaluate(inputOf({ proposal }));
        if (d.outcome === "DENY") return true;
        const cat = catalogOf();
        return d.cart.lines.every((line) => {
          const item = cat.get(line.sku);
          return item !== undefined && line.unit_cents >= marginFloor(item, PROFILE);
        });
      }),
      { numRuns: 2000 },
    );
  });

  it("the cart total always equals the sum of its line totals -- never the quoted figure", () => {
    fc.assert(
      fc.property(arbProposal, fc.integer({ min: 0, max: 10_000_000 }), (proposal, lie) => {
        const d = evaluate(inputOf({ proposal: { ...proposal, quoted_total_cents: cents(lie) } }));
        if (d.outcome === "DENY") return true;
        const summed = d.cart.lines.reduce((acc, l) => acc + l.line_total_cents, 0);
        return d.cart.total_cents === summed && d.computed_cents === summed;
      }),
      { numRuns: 2000 },
    );
  });
});

/* ------------------------------------------------------------- auto-repair --- */

describe("auto-repair (F1)", () => {

  it("clamps a below-floor offer up to the lowest legal price", () => {
    const bad = proposalOf([{ sku: "SKU_RICE_5KG", qty: 2, offer_unit_cents: 30_000 }]);
    expectDeny(evaluate(inputOf({ proposal: bad })), "MARGIN.FLOOR_BREACH");
    const repaired = repairProposal(bad, PROFILE, catalogOf());
    expect(repaired.changed).toBe(true);
    expect(repaired.adjustments).toHaveLength(1);
    expect(repaired.proposal.lines[0]!.offer_unit_cents).toBe(48_000); // discount ceiling binds
    expect(repaired.proposal.quoted_total_cents).toBe(96_000);
    expect(evaluate(inputOf({ proposal: repaired.proposal })).outcome).toBe("ALLOW");
  });

  it("leaves an already-legal proposal untouched", () => {
    const good = proposalOf([{ sku: "SKU_RICE_5KG", qty: 1, offer_unit_cents: 55_000 }]);
    const r = repairProposal(good, PROFILE, catalogOf());
    expect(r.changed).toBe(false);
    expect(r.proposal).toEqual(good);
  });

  it("PROPERTY: repair never lowers a price and always yields a floor-legal proposal", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sku: fc.constantFrom(...ITEMS.map((i) => i.sku)),
            qty: fc.integer({ min: 1, max: 5 }),
            offer_unit_cents: fc.integer({ min: 0, max: 80_000 }),
          }),
          { minLength: 1, maxLength: 3 },
        ),
        (raw) => {
          const p = proposalOf(raw);
          const r = repairProposal(p, PROFILE, catalogOf());
          const cat = catalogOf();
          return r.proposal.lines.every((line, i) => {
            const item = cat.get(line.sku)!;
            return (
              line.offer_unit_cents >= p.lines[i]!.offer_unit_cents &&
              line.offer_unit_cents >= marginFloor(item, PROFILE)
            );
          });
        },
      ),
      { numRuns: 1000 },
    );
  });
});

/* ---------------------------------------------------------- vertical-agnostic */

describe("one gate, two verticals", () => {

  it("serves a B2B profile with no change to the gate", () => {
    const b2b = {
      merchant_id: "mch_wholesale",
      display_name: "Wholesale Depot",
      vertical: "b2b_procurement" as const,
      min_margin_bps: 800,
      max_discount_bps: 3_500,
      levers: ["bulk_tier", "credit_terms"] as const,
      category_taxonomy: ["staples"],
    };
    const d = evaluate(
      inputOf({
        profile: { ...b2b, levers: [...b2b.levers] },
        signed_mandate: signed(
          mandateOf({
            vertical: "b2b_procurement",
            scope: { merchant_allowlist: ["mch_bulk"], category_allowlist: ["staples"] },
            reserved_cents: cents(5_000_000),
            max_per_txn_cents: cents(2_000_000),
            requires_human_approval_above_cents: cents(1_000_000),
            human_present: true,
          }),
        ),
        proposal: proposalOf(
          [{ sku: "SKU_RICE_5KG", qty: 20, offer_unit_cents: 44_000 }],
          { merchant_id: "mch_bulk" },
        ),
      }),
    );
    // 44000 clears the 8% B2B floor (43200) though it would breach the 15% retail floor.
    expect(d.outcome).toBe("ALLOW");
    if (d.outcome === "DENY") throw new Error("unreachable");
    expect(d.computed_cents).toBe(880_000);
  });
});

/* ------------------------------------------------- the merchant's own limits */

/**
 * The five limits a merchant sets on the shape of an order.
 *
 * These are the seller's refusals, and they are deliberately separate from the
 * mandate's: the mandate says what the buyer was authorised to spend, these say
 * what this merchant is willing to sell in one go. Either can bind first, and
 * the rule list has to say which one did -- a merchant reading its own audit
 * trail should never have to guess whose limit stopped a sale.
 *
 * Every one of them is optional, and the first test here is the one that
 * matters most: absent means absent. A profile written before these existed
 * must behave exactly as it did.
 */
describe("the merchant's own order limits", () => {
  it("does not constrain a profile that sets none of them", () => {
    // PROFILE carries no order limits at all.
    const d = evaluate(
      inputOf({
        proposal: proposalOf([
          { sku: "SKU_RICE_5KG", qty: 2, offer_unit_cents: 55_000 },
          { sku: "SKU_TEA_250G", qty: 3, offer_unit_cents: 22_000 },
        ]),
      }),
    );
    expect(d.outcome).not.toBe("DENY");
    // Recorded as considered, with a limit of zero standing for "unset".
    for (const rule of ["ORDER.LINE_CAP", "ORDER.UNIT_CAP", "ORDER.VALUE_CAP"] as const) {
      const evaluated = d.rules.find((r) => r.rule_id === rule);
      expect(evaluated?.passed).toBe(true);
      expect(evaluated?.limit).toBe(0);
    }
  });

  it("refuses a cart with more lines than the merchant accepts", () => {
    const d = evaluate(
      inputOf({
        profile: { ...PROFILE, max_order_lines: 1 },
        proposal: proposalOf([
          { sku: "SKU_RICE_5KG", qty: 1, offer_unit_cents: 55_000 },
          { sku: "SKU_TEA_250G", qty: 1, offer_unit_cents: 22_000 },
        ]),
      }),
    );
    const v = expectDeny(d, "ORDER.LINE_CAP");
    expect(v.observed).toBe(2);
    expect(v.limit).toBe(1);
  });

  it("refuses a cart with more units than the merchant accepts", () => {
    const d = evaluate(
      inputOf({
        profile: { ...PROFILE, max_order_units: 5 },
        proposal: proposalOf([
          { sku: "SKU_RICE_5KG", qty: 4, offer_unit_cents: 55_000 },
          { sku: "SKU_TEA_250G", qty: 2, offer_unit_cents: 22_000 },
        ]),
      }),
    );
    const v = expectDeny(d, "ORDER.UNIT_CAP");
    // Summed across lines, not per line.
    expect(v.observed).toBe(6);
    expect(v.limit).toBe(5);
  });

  it("refuses a cart above the largest order the merchant will close", () => {
    const d = evaluate(
      inputOf({
        profile: { ...PROFILE, max_order_cents: cents(100_000) },
        proposal: proposalOf([{ sku: "SKU_RICE_5KG", qty: 2, offer_unit_cents: 55_000 }]),
      }),
    );
    const v = expectDeny(d, "ORDER.VALUE_CAP");
    expect(v.observed).toBe(110_000);
    expect(v.limit).toBe(100_000);
  });

  /*
   * The ordering claim, tested rather than asserted. Both ceilings are breached
   * by this cart; the merchant's is checked first because the seller declining
   * a sale does not depend on what the buyer was authorised to spend.
   */
  it("reports the merchant's ceiling before the buyer's when both are breached", () => {
    const d = evaluate(
      inputOf({
        profile: { ...PROFILE, max_order_cents: cents(100_000) },
        signed_mandate: signed(mandateOf({ max_per_txn_cents: cents(120_000) })),
        proposal: proposalOf([{ sku: "SKU_RICE_5KG", qty: 3, offer_unit_cents: 55_000 }]),
      }),
    );
    expectDeny(d, "ORDER.VALUE_CAP");
    // The buyer's cap was never reached, so it is not in the rule list at all.
    expect(d.rules.some((r) => r.rule_id === "MANDATE.PER_TXN_CAP")).toBe(false);
  });

  it("leaves the buyer's per-transaction cap binding when the merchant's is looser", () => {
    const d = evaluate(
      inputOf({
        profile: { ...PROFILE, max_order_cents: cents(500_000) },
        signed_mandate: signed(mandateOf({ max_per_txn_cents: cents(100_000) })),
        proposal: proposalOf([{ sku: "SKU_RICE_5KG", qty: 3, offer_unit_cents: 55_000 }]),
      }),
    );
    expectDeny(d, "MANDATE.PER_TXN_CAP");
  });

  /* ------------------------------------------------------------- safety stock */

  it("will not sell into the merchant's safety stock", () => {
    // SKU_OIL_1L is stocked at 8. Holding 5 back leaves 3 sellable.
    const d = evaluate(
      inputOf({
        profile: { ...PROFILE, reserve_units: 5 },
        proposal: proposalOf([{ sku: "SKU_OIL_1L", qty: 4, offer_unit_cents: 17_000 }]),
      }),
    );
    const v = expectDeny(d, "INVENTORY.RESERVE");
    expect(v.observed).toBe(4); // what would be left
    expect(v.limit).toBe(5); // what must be left
  });

  it("sells right down to the safety stock but no further", () => {
    const d = evaluate(
      inputOf({
        profile: { ...PROFILE, reserve_units: 5 },
        proposal: proposalOf([{ sku: "SKU_OIL_1L", qty: 3, offer_unit_cents: 17_000 }]),
      }),
    );
    expect(d.outcome).not.toBe("DENY");
  });

  /*
   * Two different sentences, and the audit trail has to keep them apart:
   * "we do not have that many" is not "we have that many and will not sell
   * down to nothing".
   */
  it("distinguishes not enough stock from safety stock", () => {
    const short = evaluate(
      inputOf({
        profile: { ...PROFILE, reserve_units: 5 },
        proposal: proposalOf([{ sku: "SKU_OIL_1L", qty: 20, offer_unit_cents: 17_000 }]),
      }),
    );
    expectDeny(short, "INVENTORY.INSUFFICIENT");
  });

  /* --------------------------------------------------------- agent categories */

  it("refuses a category the merchant withdrew from its agent", () => {
    const d = evaluate(
      inputOf({
        // The taxonomy still carries beverages; the agent may no longer sell it.
        profile: { ...PROFILE, agent_categories: ["staples"] },
        proposal: proposalOf([{ sku: "SKU_TEA_250G", qty: 1, offer_unit_cents: 22_000 }]),
      }),
    );
    expectDeny(d, "SCOPE.MERCHANT_CATEGORIES");
  });

  it("still sells a category the merchant kept", () => {
    const d = evaluate(
      inputOf({
        profile: { ...PROFILE, agent_categories: ["staples"] },
        proposal: proposalOf([{ sku: "SKU_RICE_5KG", qty: 1, offer_unit_cents: 55_000 }]),
      }),
    );
    expect(d.outcome).not.toBe("DENY");
  });

  /*
   * The two category rules answer to different parties. The buyer's human never
   * authorised this category; the merchant is happy to sell it. Reporting the
   * merchant's refusal here would tell the buyer their own mandate was fine.
   */
  it("keeps the buyer's category scope distinct from the merchant's", () => {
    const d = evaluate(
      inputOf({
        profile: { ...PROFILE, agent_categories: ["staples", "beverages"] },
        signed_mandate: signed(
          mandateOf({
            scope: { merchant_allowlist: ["mch_demo"], category_allowlist: ["staples"] },
          }),
        ),
        proposal: proposalOf([{ sku: "SKU_TEA_250G", qty: 1, offer_unit_cents: 22_000 }]),
      }),
    );
    expectDeny(d, "SCOPE.CATEGORY_ALLOWLIST");
  });

  it("treats an absent agent_categories as the whole taxonomy", () => {
    const d = evaluate(
      inputOf({
        proposal: proposalOf([{ sku: "SKU_TEA_250G", qty: 1, offer_unit_cents: 22_000 }]),
      }),
    );
    expect(d.outcome).not.toBe("DENY");
    const evaluated = d.rules.find((r) => r.rule_id === "SCOPE.MERCHANT_CATEGORIES");
    expect(evaluated?.passed).toBe(true);
  });

  /*
   * A limit refuses; it never quietly reprices. Repair exists to clamp a price
   * up to the floor, and a cart that is simply too big is not a pricing error --
   * there is no correct number of products to silently delete from someone's
   * basket.
   */
  it("is refused rather than repaired", () => {
    const profile = { ...PROFILE, max_order_lines: 1 };
    const proposal = proposalOf([
      { sku: "SKU_RICE_5KG", qty: 1, offer_unit_cents: 55_000 },
      { sku: "SKU_TEA_250G", qty: 1, offer_unit_cents: 22_000 },
    ]);
    const repaired = repairProposal(proposal, profile, catalogOf());
    expect(repaired.changed).toBe(false);
    expect(repaired.proposal.lines).toHaveLength(2);
    expectDeny(evaluate(inputOf({ profile, proposal: repaired.proposal })), "ORDER.LINE_CAP");
  });
});
