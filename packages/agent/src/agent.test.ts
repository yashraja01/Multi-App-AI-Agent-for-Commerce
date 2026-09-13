import { describe, expect, it } from "vitest";
import {
  type CatalogItem,
  type MerchantProfile,
  type Proposal,
  type BudgetMandate,
  generateKeyPair,
  cents,
  dollars,
  signValue,
} from "@mercury/core";
import { lowestLegalUnit } from "@mercury/gate";
import { FixtureRail } from "@mercury/rail";
import { Ledger } from "@mercury/ledger";
import { Store } from "@mercury/store";
import { Engine } from "./engine.js";
import { gateVia } from "./bridge.js";
import type { NegotiatorContext } from "./negotiator.js";
import { inferCart, ordinaryUnit } from "./basket.js";
import { ScriptedRevenueAgent } from "./scripted-agent.js";
import { personaFor, systemPrompt } from "./prompts.js";
import {
  type RunnableTool,
  priceFloor,
  quoteTotal,
  revenueTools,
  searchCatalog,
} from "./tools.js";
import { LlmRevenueAgent, type LlmOptions } from "./llm-agent.js";

/**
 * The agent, end to end, with no API key and no network.
 *
 * Everything here runs the real gate, the real ledger and the real (fixture)
 * rail. Only the model's judgement is substituted, by `ScriptedRevenueAgent` --
 * which calls the same tool implementations Claude calls.
 */

/* ------------------------------------------------------------- fixtures --- */

const KEYS = generateKeyPair();
const AGENT_KEYS = generateKeyPair();

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
  levers: ["bulk_tier", "credit_terms"],
  category_taxonomy: ["staples"],
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

const QUICK_ITEMS: CatalogItem[] = [
  item({ sku: "QC_OATMILK_1L" }),
  item({
    sku: "QC_TEA_20CT",
    title: "Green Tea (20 bags)",
    category: "beverages",
    unit: "pack",
    list_cents: dollars(250),
    cost_cents: dollars(150),
    stock: 100,
  }),
];

const BULK_ITEMS: CatalogItem[] = [
  item({
    sku: "WS_COFFEE_5LB",
    merchant_id: "mch_bulk",
    title: "Whole Bean Coffee 5lb",
    unit: "bag",
    list_cents: dollars(2_800),
    cost_cents: dollars(2_200),
    stock: 200,
    moq: 4,
  }),
];

function mandateOf(over: Partial<BudgetMandate> = {}): BudgetMandate {
  const now = Date.now();
  return {
    mandate_id: "mnd_test",
    principal_id: "prn_test",
    agent_id: "agt_buyer",
    agent_public_key: AGENT_KEYS.publicKey,
    vertical: "quick_commerce",
    reserved_cents: dollars(5_000),
    max_per_txn_cents: dollars(2_000),
    max_txn_count: 8,
    requires_human_approval_above_cents: dollars(1_500),
    scope: {
      merchant_allowlist: ["mch_quick", "mch_bulk"],
      category_allowlist: ["staples", "beverages"],
    },
    human_present: false,
    not_before: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 86_400_000).toISOString(),
    nonce: "test",
    ...over,
  };
}

interface Harness {
  engine: Engine;
  store: Store;
  ledger: Ledger;
  rail: FixtureRail;
  ctx: (profile: MerchantProfile, submit: NegotiatorContext["submit"]) => NegotiatorContext;
  catalog: ReadonlyMap<string, CatalogItem>;
}

function harness(
  profile: MerchantProfile = QUICK,
  items: CatalogItem[] = QUICK_ITEMS,
  mandate: BudgetMandate = mandateOf(),
): Harness {
  const store = Store.open(":memory:");
  const ledger = Ledger.open(":memory:");
  const rail = new FixtureRail({ now: () => 1_700_000_000_000 });

  store.putMerchant(profile);
  for (const i of items) store.putItem(i);
  store.putPrincipal(mandate.principal_id, KEYS.publicKey);
  store.putMandate({
    mandate,
    signature: signValue(mandate, KEYS.privateKey),
    public_key: KEYS.publicKey,
  });

  const engine = new Engine({ store, ledger, rail });
  const catalog = store.catalogFor(profile.merchant_id);

  return {
    engine,
    store,
    ledger,
    rail,
    catalog,
    ctx: (p, submit) => ({
      profile: p,
      catalog: store.catalogFor(p.merchant_id),
      persona: personaFor(p.vertical),
      submit,
      maxRounds: 3,
    }),
  };
}

/* ------------------------------------------------------------- the tools --- */

describe("the shared tool surface", () => {
  it("never exposes landed cost to the agent", () => {
    const h = harness();
    const ctx = h.ctx(QUICK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));
    const rows = searchCatalog(ctx, {});

    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("cost_cents");
      expect(JSON.stringify(row)).not.toContain("40000");
    }
    h.store.close();
  });

  it("reports a floor the agent can legally offer at", () => {
    const h = harness();
    const ctx = h.ctx(QUICK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));
    const [floor] = priceFloor(ctx, ["QC_OATMILK_1L"]);

    expect(floor).toBeDefined();
    const oatmilk = h.catalog.get("QC_OATMILK_1L");
    expect(oatmilk).toBeDefined();
    if (oatmilk === undefined || floor === undefined) throw new Error("unreachable");
    expect(floor.lowest_legal_unit_cents).toBe(lowestLegalUnit(oatmilk, QUICK));
    // 15% over a $400 cost is $460; the 20% discount ceiling allows $480.
    expect(floor.lowest_legal_unit_cents).toBe(dollars(480));
    h.store.close();
  });

  it("declares every tool strict, with no additional properties", () => {
    const h = harness();
    const ctx = h.ctx(QUICK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));
    const tools = revenueTools(ctx, {
      record: () => undefined,
      settled: () => false,
      rounds: () => 0,
    });

    expect(tools.map((t) => t.name).sort()).toEqual([
      "bulk_tier_quote",
      "find_substitute",
      "price_floor",
      "search_catalog",
      "submit_offer",
      "suggest_bundle",
    ]);
    for (const tool of tools) {
      expect(tool.strict).toBe(true);
      const schema = (tool as unknown as { input_schema: Record<string, unknown> }).input_schema;
      expect(schema["additionalProperties"]).toBe(false);
    }
    h.store.close();
  });

  it("serves both verticals from one tool set", () => {
    const quick = harness();
    const bulk = harness(BULK, BULK_ITEMS);
    const noop: NegotiatorContext["submit"] = async () => ({
      outcome: "DENY",
      rule_ids: [],
      messages: [],
    });

    const a = revenueTools(quick.ctx(QUICK, noop), {
      record: () => undefined,
      settled: () => false,
      rounds: () => 0,
    });
    const b = revenueTools(bulk.ctx(BULK, noop), {
      record: () => undefined,
      settled: () => false,
      rounds: () => 0,
    });

    // Same names, same schemas. Only the data behind them differs.
    const schemas = (tools: typeof a): string[] =>
      tools.map((t) => JSON.stringify((t as { input_schema: unknown }).input_schema));

    expect(a.map((t) => t.name)).toEqual(b.map((t) => t.name));
    expect(schemas(a)).toEqual(schemas(b));
    quick.store.close();
    bulk.store.close();
  });
});

/* --------------------------------------------------------------- prompts --- */

describe("prompts", () => {
  it("assembles shared rules plus a per-vertical persona", () => {
    const quick = systemPrompt(personaFor("quick_commerce"));
    const b2b = systemPrompt(personaFor("b2b_procurement"));

    expect(quick).toContain("You propose. The gate disposes.");
    expect(b2b).toContain("You propose. The gate disposes.");
    expect(quick).toContain("Corner Fresh Market");
    expect(b2b).toContain("Harbor Wholesale Supply");
    expect(quick).not.toBe(b2b);

    // The shared half must be byte-identical, or the cache prefix splits.
    const shared = quick.slice(0, quick.indexOf("\n\n---\n\n"));
    expect(b2b.startsWith(shared)).toBe(true);
  });
});

/* ---------------------------------------------------------- negotiation --- */

describe("the Revenue Agent", () => {
  it("closes a normal basket and creates exactly one order", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_1" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_OATMILK_1L", qty: 2 }],
    });

    const result = await agent.negotiate({
      session_id: "ses_1",
      buyer_message: "Two cartons of oat milk please.",
    });

    expect(result.settled).toBeDefined();
    expect(result.rounds.length).toBe(1);
    expect(result.settled?.feedback.outcome).toBe("ALLOW");
    expect(bridge.results().filter((r) => r.kind !== "DENIED").length).toBe(1);
    expect(h.ledger.byEventType("ORDER_CREATED").length).toBe(1);
    h.store.close();
  });

  it("charges the gate's total, never the agent's", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_2" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_OATMILK_1L", qty: 2 }],
    });

    await agent.negotiate({ session_id: "ses_2", buyer_message: "oat milk" });

    const accepted = bridge.accepted();
    expect(accepted?.kind).toBe("AUTHORISED");
    if (accepted === undefined || accepted.kind === "DENIED") throw new Error("unreachable");
    const order = h.store.getOrder(accepted.order_id);
    expect(order?.amount).toBe(accepted.decision.computed_cents);
    expect(order?.amount).toBe(accepted.cart.total_cents);
    h.store.close();
  });

  /* F1 -- the failure this milestone exists to make reachable. */
  it("F1: a below-floor offer is denied, and the agent re-quotes legally", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_f1" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_OATMILK_1L", qty: 2 }],
      // The buyer pushed, and the agent caved by $50 a bag.
      underCutCents: dollars(50),
    });

    const result = await agent.negotiate({
      session_id: "ses_f1",
      buyer_message: "$430 a bag or I go elsewhere.",
    });

    expect(result.rounds.length).toBe(2);
    const [denied, allowed] = result.rounds;
    expect(denied?.feedback.outcome).toBe("DENY");
    expect(denied?.feedback.rule_ids).toContain("MARGIN.FLOOR_BREACH");
    expect(allowed?.feedback.outcome).toBe("ALLOW");

    // The re-quote lands exactly on the floor, not above it.
    const oatmilk = h.catalog.get("QC_OATMILK_1L");
    if (oatmilk === undefined) throw new Error("unreachable");
    expect(allowed?.proposal.lines[0]?.offer_unit_cents).toBe(lowestLegalUnit(oatmilk, QUICK));

    // And the denial made no rail call at all.
    expect(h.ledger.byEventType("ORDER_CREATED").length).toBe(1);
    expect(h.ledger.byEventType("MANDATE_BREACH_BLOCKED").length).toBe(1);
    h.store.close();
  });

  /* Drift: the agent's arithmetic disagreeing with the gate's. */
  it("F1: a quoted total that does not match the lines is denied as drift", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_drift" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_OATMILK_1L", qty: 2 }],
      driftCents: 1,
      reQuote: false,
    });

    const result = await agent.negotiate({ session_id: "ses_drift", buyer_message: "oat milk" });

    expect(result.settled).toBeUndefined();
    expect(result.rounds[0]?.feedback.rule_ids).toContain("DRIFT.AMOUNT_MISMATCH");
    expect(h.ledger.byEventType("ORDER_CREATED").length).toBe(0);
    expect(h.ledger.byEventType("DRIFT_BLOCKED").length).toBeGreaterThan(0);
    h.store.close();
  });

  it("routes a large basket to a human step-up rather than paying it", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_stepup" });
    // 3 bags at list is $1,800: over the $1,500 approval threshold, but
    // still inside the $2,000 per-transaction cap -- so it is a step-up, not
    // a denial.
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_OATMILK_1L", qty: 3 }],
      discountBps: 0,
    });

    const result = await agent.negotiate({ session_id: "ses_stepup", buyer_message: "three bags" });

    expect(result.settled?.feedback.outcome).toBe("ALLOW_WITH_STEPUP");
    expect(result.reply).toContain("approval link");
    expect(h.ledger.byEventType("STEPUP_ISSUED").length).toBe(1);
    h.store.close();
  });

  it("F6: a basket beyond the envelope is denied with zero rail calls", async () => {
    const h = harness(QUICK, QUICK_ITEMS, mandateOf({ max_per_txn_cents: dollars(100) }));
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_f6" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_OATMILK_1L", qty: 2 }],
    });

    const result = await agent.negotiate({ session_id: "ses_f6", buyer_message: "oat milk" });

    expect(result.settled).toBeUndefined();
    expect(result.rounds.every((r) => r.feedback.outcome === "DENY")).toBe(true);
    expect(h.ledger.byEventType("ORDER_CREATED").length).toBe(0);
    expect(h.ledger.byEventType("MANDATE_BREACH_BLOCKED").length).toBeGreaterThan(0);
    h.store.close();
  });

  it("the same agent code serves a B2B merchant with different economics", async () => {
    const h = harness(
      BULK,
      BULK_ITEMS,
      mandateOf({
        vertical: "b2b_procurement",
        reserved_cents: dollars(300_000),
        max_per_txn_cents: dollars(150_000),
        requires_human_approval_above_cents: dollars(200_000),
        human_present: true,
      }),
    );
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_b2b" });
    const agent = new ScriptedRevenueAgent(h.ctx(BULK, bridge.submit), {
      want: [{ sku: "WS_COFFEE_5LB", qty: 10 }],
      // 30% off list is legal here and would be a hard DENY at the quick-commerce merchant.
      discountBps: 3_000,
    });

    const result = await agent.negotiate({
      session_id: "ses_b2b",
      buyer_message: "Ten bags of coffee, best price.",
    });

    expect(result.settled?.feedback.outcome).toBe("ALLOW");
    expect(result.rounds.length).toBe(1);
    h.store.close();
  });

  it("stops after the round limit instead of negotiating forever", async () => {
    const h = harness();
    let calls = 0;
    const ctx = h.ctx(QUICK, async () => {
      calls += 1;
      return {
        outcome: "DENY",
        rule_ids: ["MARGIN.FLOOR_BREACH"],
        messages: ["MARGIN.FLOOR_BREACH: below floor (observed 1, limit 2)"],
      };
    });
    // Always re-quotes, always denied: the loop must still terminate.
    const agent = new ScriptedRevenueAgent(
      { ...ctx, maxRounds: 3 },
      { want: [{ sku: "QC_OATMILK_1L", qty: 1 }], underCutCents: dollars(100) },
    );

    const result = await agent.negotiate({ session_id: "ses_loop", buyer_message: "oat milk" });

    expect(calls).toBeLessThanOrEqual(3);
    expect(result.settled).toBeUndefined();
    // The buyer is told why in plain words; the rule id stays in the ledger.
    expect(result.reply).toContain("lowest we can do");
    expect(result.reply).not.toContain("MARGIN.FLOOR_BREACH");
    h.store.close();
  });

  it("says so rather than inventing a SKU it does not stock", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_none" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {});

    const result = await agent.negotiate({
      session_id: "ses_none",
      buyer_message: "Do you sell motorcycle tyres?",
    });

    expect(result.rounds.length).toBe(0);
    expect(result.reply).toContain("do not stock");
    h.store.close();
  });
});

/* --------------------------------------------------------- revenue levers --- */

describe("the revenue levers, through the gate", () => {
  it("bulk tier lifts basket value and still passes the gate", async () => {
    const h = harness(
      BULK,
      BULK_ITEMS,
      mandateOf({
        vertical: "b2b_procurement",
        reserved_cents: dollars(300_000),
        max_per_txn_cents: dollars(150_000),
        requires_human_approval_above_cents: dollars(200_000),
      }),
    );
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_tier" });
    const agent = new ScriptedRevenueAgent(h.ctx(BULK, bridge.submit), {});

    const result = await agent.negotiate({
      session_id: "ses_tier",
      buyer_message: "I need 25 bags of whole bean coffee",
    });

    expect(result.settled?.feedback.outcome).toBe("ALLOW");
    expect(result.value?.levers_used).toContain("bulk_tier");
    // A tier is a discount, so this basket is *cheaper* than the ordinary
    // quote -- the uplift comes from volume, which the buyer chose.
    expect(result.value?.final_cents).toBeGreaterThan(0);
    expect(result.settled?.proposal.lines[0]?.qty).toBe(25);
    h.store.close();
  });

  it("bulk tier never prices a line below the floor the gate enforces", async () => {
    const h = harness(
      BULK,
      BULK_ITEMS,
      mandateOf({
        vertical: "b2b_procurement",
        reserved_cents: dollars(300_000),
        max_per_txn_cents: dollars(150_000),
        requires_human_approval_above_cents: dollars(200_000),
      }),
    );
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_floor" });
    const agent = new ScriptedRevenueAgent(h.ctx(BULK, bridge.submit), {});

    const result = await agent.negotiate({
      session_id: "ses_floor",
      buyer_message: "50 bags of coffee please",
    });

    const coffee = h.catalog.get("WS_COFFEE_5LB");
    if (coffee === undefined) throw new Error("unreachable");
    // Deepest tier, and the gate still allowed it -- because the lever clamped.
    expect(result.settled?.feedback.outcome).toBe("ALLOW");
    expect(result.settled?.proposal.lines[0]?.offer_unit_cents).toBeGreaterThanOrEqual(
      lowestLegalUnit(coffee, BULK),
    );
    h.store.close();
  });

  it("bundle raises the basket when the buyer invites it", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_bundle" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {});

    const plain = await new ScriptedRevenueAgent(
      h.ctx(QUICK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] })),
      {},
    ).negotiate({ session_id: "ses_x", buyer_message: "two cartons of oat milk" });

    const invited = await agent.negotiate({
      session_id: "ses_bundle",
      buyer_message: "two cartons of oat milk, and stock me up for the week",
    });

    expect(invited.value?.levers_used).toContain("bundle");
    expect(invited.settled?.feedback.outcome).toBe("ALLOW");
    // More lines than the plain request produced, and a real uplift.
    expect(invited.settled?.proposal.lines.length).toBeGreaterThan(
      plain.rounds[0]?.proposal.lines.length ?? 0,
    );
    expect(invited.value?.uplift_cents ?? 0).toBeGreaterThan(0);
    h.store.close();
  });

  it("does not pad a basket the buyer did not open up", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_nopad" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {});

    const result = await agent.negotiate({
      session_id: "ses_nopad",
      buyer_message: "just two cartons of oat milk",
    });

    // The add-on is offered in words, never added to the cart.
    expect(result.value?.levers_used ?? []).not.toContain("bundle");
    expect(result.settled?.proposal.lines.map((l) => l.sku)).toEqual(["QC_OATMILK_1L"]);
    expect(result.suggestion).toBeDefined();
    expect(result.reply).toContain("you could add");
    h.store.close();
  });

  it("substitutes a short line rather than proposing a cart that cannot ship", async () => {
    const scarce: CatalogItem[] = [
      item({ sku: "QC_OLIVEOIL_500ML", title: "Olive Oil 500ml", list_cents: dollars(900), cost_cents: dollars(700), stock: 1 }),
      item({ sku: "QC_OATMILK_1L" }),
    ];
    const h = harness(QUICK, scarce);
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_sub" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_OLIVEOIL_500ML", qty: 3 }],
    });

    const result = await agent.negotiate({ session_id: "ses_sub", buyer_message: "three olive oil" });

    expect(result.value?.levers_used).toContain("substitute");
    expect(result.substitutions?.[0]?.from_sku).toBe("QC_OLIVEOIL_500ML");
    expect(result.settled?.proposal.lines.map((l) => l.sku)).not.toContain("QC_OLIVEOIL_500ML");
    h.store.close();
  });

  it("records what the levers were worth, for the ledger to carry", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_value" });
    const agent = new ScriptedRevenueAgent(h.ctx(QUICK, bridge.submit), {
      want: [{ sku: "QC_OATMILK_1L", qty: 2 }],
    });

    const result = await agent.negotiate({ session_id: "ses_value", buyer_message: "oat milk" });

    expect(result.value).toBeDefined();
    expect(result.value?.baseline_cents).toBeGreaterThan(0);
    expect(result.value?.final_cents).toBe(result.settled?.feedback.computed_total_cents);
    h.store.close();
  });
});

/* ------------------------------------------------------ cart inference --- */

describe("cart inference", () => {
  it("reads a quantity and a product out of plain text", () => {
    const h = harness(BULK, BULK_ITEMS);
    const ctx = h.ctx(BULK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));

    expect(inferCart(ctx, "I need 10 bags of whole bean coffee")).toEqual([
      { sku: "WS_COFFEE_5LB", qty: 10 },
    ]);
    h.store.close();
  });

  it("reads written numbers, not just digits", () => {
    const h = harness();
    const ctx = h.ctx(QUICK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));

    expect(inferCart(ctx, "two cartons of oat milk and a box of tea")).toEqual([
      { sku: "QC_OATMILK_1L", qty: 2 },
      { sku: "QC_TEA_20CT", qty: 1 },
    ]);
    h.store.close();
  });

  it("does not match a SKU on its packaging word", () => {
    const h = harness();
    const ctx = h.ctx(QUICK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));

    // "pack" appears in several titles. A buyer asking for "a pack of tea"
    // wants tea, and nothing else.
    const cart = inferCart(ctx, "a pack of tea");
    expect(cart).toEqual([{ sku: "QC_TEA_20CT", qty: 1 }]);
    h.store.close();
  });

  it("gives each line its own quantity", () => {
    const h = harness();
    const ctx = h.ctx(QUICK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));

    // The eight must not leak onto the milk.
    expect(inferCart(ctx, "two cartons of oat milk and eight boxes of tea")).toEqual([
      { sku: "QC_OATMILK_1L", qty: 2 },
      { sku: "QC_TEA_20CT", qty: 8 },
    ]);
    h.store.close();
  });

  it("never proposes a quantity below the SKU minimum order quantity", () => {
    const h = harness(BULK, BULK_ITEMS);
    const ctx = h.ctx(BULK, async () => ({ outcome: "DENY", rule_ids: [], messages: [] }));

    const cart = inferCart(ctx, "just 1 bag of coffee");
    expect(cart[0]?.qty).toBeGreaterThanOrEqual(4);
    h.store.close();
  });
});

/* ------------------------------------------------------------ arithmetic --- */

describe("quoteTotal", () => {
  it("is the sum the gate checks the agent against", () => {
    const lines: Proposal["lines"] = [
      { sku: "A", qty: 3, offer_unit_cents: cents(1_999) },
      { sku: "B", qty: 2, offer_unit_cents: cents(500) },
    ];
    expect(quoteTotal(lines)).toBe(3 * 1_999 + 2 * 500);
  });
});

/* ------------------------------------------------------- the model's path --- */

/**
 * `LlmRevenueAgent`, driven over a fake transport.
 *
 * The point is not to test Claude. It is to test everything around Claude: that
 * the lever tools exist and are reachable, that a lever the merchant has not
 * permitted returns nothing to price with, and -- the part that matters for the
 * merchant console -- that uplift is attributed to a lever only when the lever
 * is visible in the cart the gate actually approved.
 *
 * The fake plays the part of the model: it calls the real tools, with real
 * arguments, and submits a real proposal through the real gate. Only the
 * judgement about *which* tool to call next is scripted. Before this existed,
 * `LlmRevenueAgent` had never executed at all.
 */

type Play = (call: (name: string, input: unknown) => Promise<string>) => Promise<string>;

function fakeClaude(play: Play): NonNullable<LlmOptions["client"]> {
  return {
    beta: {
      messages: {
        toolRunner(params: { tools: RunnableTool[] }) {
          const byName = new Map(params.tools.map((t) => [t.name, t]));
          const call = async (name: string, input: unknown): Promise<string> => {
            const tool = byName.get(name);
            if (tool === undefined) {
              throw new Error(`the model called a tool that does not exist: ${name}`);
            }
            const run = (tool as unknown as { run: (i: unknown) => unknown }).run;
            return String(await run(input));
          };
          return {
            pushMessages: () => undefined,
            async *[Symbol.asyncIterator]() {
              const text = await play(call);
              yield {
                content: [{ type: "text", text }],
                stop_reason: "end_turn",
                usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
              };
            },
          };
        },
      },
    },
  } as unknown as NonNullable<LlmOptions["client"]>;
}

const BIG_MANDATE = {
  vertical: "b2b_procurement" as const,
  reserved_cents: dollars(300_000),
  max_per_txn_cents: dollars(150_000),
  requires_human_approval_above_cents: dollars(200_000),
};

describe("the Revenue Agent, with the model driving", () => {
  it("gives the model nothing to price with on a lever the merchant forbids", async () => {
    // QUICK permits bundle and substitute. It does not permit bulk_tier.
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_forbid" });
    let answer = "";

    const agent = new LlmRevenueAgent(h.ctx(QUICK, bridge.submit), {
      client: fakeClaude(async (call) => {
        answer = await call("bulk_tier_quote", { sku: "QC_OATMILK_1L", qty: 10 });
        return "no tier here";
      }),
    });
    await agent.negotiate({ session_id: "ses_forbid", buyer_message: "two cartons of oat milk" });

    const parsed = JSON.parse(answer) as { available: boolean; unit_cents?: number };
    expect(parsed.available).toBe(false);
    // A refusal must not leak a price the merchant never authorised.
    expect(parsed.unit_cents).toBeUndefined();
    h.store.close();
  });

  it("moves a buyer up a rung, and attributes the uplift to the tier", async () => {
    const h = harness(BULK, BULK_ITEMS, mandateOf(BIG_MANDATE));
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_rung" });

    const agent = new LlmRevenueAgent(h.ctx(BULK, bridge.submit), {
      client: fakeClaude(async (call) => {
        await call("search_catalog", { query: "", category: "" });
        // The buyer asked for four. The next rung on the ladder is five.
        const tier = JSON.parse(
          await call("bulk_tier_quote", { sku: "WS_COFFEE_5LB", qty: 5 }),
        ) as { unit_cents: number; discount_bps: number };
        await call("submit_offer", {
          lines: [{ sku: "WS_COFFEE_5LB", qty: 5, offer_unit_cents: tier.unit_cents }],
          quoted_total_cents: tier.unit_cents * 5,
          rationale: "One more sack reaches the next price break.",
        });
        return "Five sacks costs less per sack than four.";
      }),
    });

    const result = await agent.negotiate({
      session_id: "ses_rung",
      buyer_message: "I need 4 bags of whole bean coffee",
    });

    expect(result.settled?.feedback.outcome).toBe("ALLOW");
    expect(result.value?.levers_used).toContain("bulk_tier");
    // The basket the buyer would have bought was four sacks at ordinary
    // pricing. The lever earned its discount by selling a fifth.
    expect(result.value?.final_cents ?? 0).toBeGreaterThan(result.value?.baseline_cents ?? 0);
    expect(result.value?.uplift_bps ?? 0).toBeGreaterThan(0);
    h.store.close();
  });

  it("attributes nothing to a lever the model looked at and did not use", async () => {
    const h = harness(BULK, BULK_ITEMS, mandateOf(BIG_MANDATE));
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_idle" });
    const ctx = h.ctx(BULK, bridge.submit);
    const ordinary = ordinaryUnit(ctx, "WS_COFFEE_5LB");

    const agent = new LlmRevenueAgent(ctx, {
      client: fakeClaude(async (call) => {
        // Reads the ladder, then quotes the ordinary price anyway.
        await call("bulk_tier_quote", { sku: "WS_COFFEE_5LB", qty: 5 });
        await call("submit_offer", {
          lines: [{ sku: "WS_COFFEE_5LB", qty: 4, offer_unit_cents: ordinary }],
          quoted_total_cents: ordinary * 4,
          rationale: "Four sacks at our standard price.",
        });
        return "Four sacks it is.";
      }),
    });

    const result = await agent.negotiate({
      session_id: "ses_idle",
      buyer_message: "I need 4 bags of whole bean coffee",
    });

    expect(result.settled?.feedback.outcome).toBe("ALLOW");
    // Consulting a tool is not pulling a lever. The console must not say it was.
    expect(result.value?.levers_used).toEqual([]);
    expect(result.value?.uplift_cents).toBe(0);
    h.store.close();
  });

  it("offers an uninvited add-on as a suggestion, never as a cart line", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_polite" });
    const ctx = h.ctx(QUICK, bridge.submit);
    const oatmilk = ordinaryUnit(ctx, "QC_OATMILK_1L");
    let invited = true;

    const agent = new LlmRevenueAgent(ctx, {
      client: fakeClaude(async (call) => {
        const bundle = JSON.parse(
          await call("suggest_bundle", {
            lines: [{ sku: "QC_OATMILK_1L", qty: 2, unit_cents: oatmilk }],
          }),
        ) as { invited: boolean; suggestion: { title: string } };
        invited = bundle.invited;
        // Not invited, so the add-on is mentioned and the cart is left alone.
        await call("submit_offer", {
          lines: [{ sku: "QC_OATMILK_1L", qty: 2, offer_unit_cents: oatmilk }],
          quoted_total_cents: oatmilk * 2,
          rationale: "Two cartons of oat milk.",
        });
        return `Two cartons of oat milk. We also have ${bundle.suggestion.title} if you want it.`;
      }),
    });

    const result = await agent.negotiate({
      session_id: "ses_polite",
      buyer_message: "two cartons of oat milk",
    });

    expect(invited).toBe(false);
    expect(result.settled?.feedback.outcome).toBe("ALLOW");
    expect(result.settled?.proposal.lines).toHaveLength(1);
    // Offered but not taken: a suggestion on the result, and no lever credit.
    expect(result.suggestion?.sku).toBe("QC_TEA_20CT");
    expect(result.value?.levers_used).not.toContain("bundle");
    h.store.close();
  });

  it("credits the bundle only once the invited add-on is in the approved cart", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_invited" });
    const ctx = h.ctx(QUICK, bridge.submit);
    const oatmilk = ordinaryUnit(ctx, "QC_OATMILK_1L");

    const agent = new LlmRevenueAgent(ctx, {
      client: fakeClaude(async (call) => {
        const bundle = JSON.parse(
          await call("suggest_bundle", {
            lines: [{ sku: "QC_OATMILK_1L", qty: 2, unit_cents: oatmilk }],
          }),
        ) as { invited: boolean; suggestion: { sku: string; qty: number; unit_cents: number } };
        expect(bundle.invited).toBe(true);
        const add = bundle.suggestion;
        await call("submit_offer", {
          lines: [
            { sku: "QC_OATMILK_1L", qty: 2, offer_unit_cents: oatmilk },
            { sku: add.sku, qty: add.qty, offer_unit_cents: add.unit_cents },
          ],
          quoted_total_cents: oatmilk * 2 + add.unit_cents * add.qty,
          rationale: "Oat milk, plus the tea to save a second trip.",
        });
        return "Oat milk and tea, one delivery.";
      }),
    });

    const result = await agent.negotiate({
      session_id: "ses_invited",
      buyer_message: "two cartons of oat milk, and stock me up for the week",
    });

    expect(result.settled?.feedback.outcome).toBe("ALLOW");
    expect(result.settled?.proposal.lines).toHaveLength(2);
    expect(result.value?.levers_used).toContain("bundle");
    expect(result.value?.uplift_cents ?? 0).toBeGreaterThan(0);
    // In the cart is not a suggestion any more.
    expect(result.suggestion).toBeUndefined();
    h.store.close();
  });

  it("records the prompt and model provenance the ledger needs", async () => {
    const h = harness();
    const bridge = gateVia(h.engine, { mandate_id: "mnd_test", session_id: "ses_prov" });
    const agent = new LlmRevenueAgent(h.ctx(QUICK, bridge.submit), {
      model: "claude-opus-5",
      effort: "high",
      client: fakeClaude(async () => "nothing to quote"),
    });

    const result = await agent.negotiate({
      session_id: "ses_prov",
      buyer_message: "two cartons of oat milk",
    });

    expect(result.llm?.model).toBe("claude-opus-5");
    expect(result.llm?.effort).toBe("high");
    expect(result.llm?.input_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.llm?.output_hash).toMatch(/^[0-9a-f]{64}$/u);
    h.store.close();
  });
});
