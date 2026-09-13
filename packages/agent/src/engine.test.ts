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
import { FixtureRail, TEST_PM_DECLINED, TEST_PM_SUCCESS } from "@mercury/rail";
import { Ledger } from "@mercury/ledger";
import { Store } from "@mercury/store";
import { Engine } from "./engine.js";

/**
 * The settlement path, at the Engine.
 *
 * These are the two failure rows that had no end-to-end coverage: a payment
 * that declines (F2) and money captured for goods that cannot ship (F3's
 * second half). Both are about what happens *after* the gate has said yes,
 * which is exactly where a policy engine stops helping.
 */

const KEYS = generateKeyPair();
const AGENT_KEYS = generateKeyPair();

const PROFILE: MerchantProfile = {
  merchant_id: "mch_quick",
  display_name: "Corner Fresh Market",
  vertical: "quick_commerce",
  min_margin_bps: 1_500,
  max_discount_bps: 2_000,
  levers: ["bundle", "substitute"],
  category_taxonomy: ["staples"],
};

const OLIVE_OIL: CatalogItem = {
  sku: "QC_OLIVEOIL_500ML",
  merchant_id: "mch_quick",
  title: "Olive Oil 500ml",
  category: "staples",
  unit: "tin",
  list_cents: dollars(900),
  cost_cents: dollars(700),
  stock: 1,
  moq: 1,
};

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
    scope: { merchant_allowlist: ["mch_quick"], category_allowlist: ["staples"] },
    human_present: false,
    not_before: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 86_400_000).toISOString(),
    nonce: "test",
    ...over,
  };
}

function harness(items: CatalogItem[] = [OLIVE_OIL]) {
  const store = Store.open(":memory:");
  const ledger = Ledger.open(":memory:");
  const rail = new FixtureRail({ now: () => 1_700_000_000_000 });
  const mandate = mandateOf();

  store.putMerchant(PROFILE);
  for (const i of items) store.putItem(i);
  store.putPrincipal(mandate.principal_id, KEYS.publicKey);
  store.putMandate({
    mandate,
    signature: signValue(mandate, KEYS.privateKey),
    public_key: KEYS.publicKey,
  });

  return { store, ledger, rail, engine: new Engine({ store, ledger, rail }) };
}

function offerOf(sku: string, qty: number, unit: number): Proposal {
  return {
    merchant_id: "mch_quick",
    lines: [{ sku, qty, offer_unit_cents: cents(unit) }],
    quoted_total_cents: cents(unit * qty),
    rationale: "test",
  };
}

/* ------------------------------------------------------------------ F2 --- */

describe("F2: a payment that declines", () => {
  it("retries a bounded number of times, then hands control to a human", async () => {
    const h = harness();
    const authorised = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_f2",
      proposal: offerOf("QC_OLIVEOIL_500ML", 1, dollars(880)),
    });
    if (authorised.kind !== "AUTHORISED") throw new Error(`expected AUTHORISED, got ${authorised.kind}`);

    const result = await h.engine.settle({
      order_id: authorised.order_id,
      token_id: authorised.token.token_id,
      session_id: "ses_f2",
      payment_method: TEST_PM_DECLINED,
    });

    expect(result.kind).toBe("FAILED_FALLBACK_LINK");
    if (result.kind !== "FAILED_FALLBACK_LINK") throw new Error("unreachable");

    // Bounded: the default budget is 2 retries, so 3 attempts and no more.
    expect(result.attempts).toBe(3);
    expect(result.link_url).toContain("buy.stripe.com");

    const events = h.ledger.read().map((e) => e.event_type);
    expect(events.filter((e) => e === "PAYMENT_FAILED").length).toBe(3);
    expect(events).toContain("RETRY_BOUNDED");
    expect(events).toContain("STEPUP_ISSUED");
    h.store.close();
  });

  it("does not draw down the envelope for a payment that never captured", async () => {
    const h = harness();
    const authorised = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_f2b",
      proposal: offerOf("QC_OLIVEOIL_500ML", 1, dollars(880)),
    });
    if (authorised.kind !== "AUTHORISED") throw new Error("expected AUTHORISED");

    await h.engine.settle({
      order_id: authorised.order_id,
      token_id: authorised.token.token_id,
      session_id: "ses_f2b",
      payment_method: TEST_PM_DECLINED,
    });

    expect(h.store.getMandateState("mnd_test")?.consumed_cents).toBe(0);
    h.store.close();
  });
});

/* ------------------------------------------------------------------ F3 --- */

describe("F3: captured, then unshippable", () => {
  it("refunds, restores the stock, and restores the envelope", async () => {
    const h = harness();
    const authorised = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_f3",
      proposal: offerOf("QC_OLIVEOIL_500ML", 1, dollars(880)),
    });
    if (authorised.kind !== "AUTHORISED") throw new Error("expected AUTHORISED");

    const settled = await h.engine.settle({
      order_id: authorised.order_id,
      token_id: authorised.token.token_id,
      session_id: "ses_f3",
      payment_method: TEST_PM_SUCCESS,
    });
    if (settled.kind !== "CAPTURED") throw new Error("expected CAPTURED");

    // Money moved and the last tin is spoken for.
    expect(h.store.getMandateState("mnd_test")?.consumed_cents).toBe(dollars(880));
    expect(h.store.getItem("QC_OLIVEOIL_500ML")?.stock).toBe(0);

    const compensated = await h.engine.compensate({
      order_id: authorised.order_id,
      payment_id: settled.payment_id,
      session_id: "ses_f3",
      reason: "stock unavailable after capture",
      restore: [{ sku: "QC_OLIVEOIL_500ML", qty: 1 }],
    });

    expect(compensated.kind).toBe("REFUNDED");
    // The principal is exactly where they started.
    expect(h.store.getMandateState("mnd_test")?.consumed_cents).toBe(0);
    expect(h.store.getItem("QC_OLIVEOIL_500ML")?.stock).toBe(1);
    expect(h.store.getOrder(authorised.order_id)?.status).toBe("refunded");

    const events = h.ledger.read().map((e) => e.event_type);
    expect(events).toContain("AUTO_REFUND_ISSUED");
    h.store.close();
  });

  it("records the cart lines on the order, so compensation knows what to restore", async () => {
    const h = harness();
    const authorised = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_lines",
      proposal: offerOf("QC_OLIVEOIL_500ML", 1, dollars(880)),
    });
    if (authorised.kind !== "AUTHORISED") throw new Error("expected AUTHORISED");

    const created = h.ledger.byEventType("ORDER_CREATED")[0];
    const lines = (
      created?.detail as
        | { lines?: { sku: string; qty: number; line_total_cents: number }[] }
        | undefined
    )?.lines;

    // The line total rides along too: split settlement divides a captured
    // payment by what each supplier actually sold, and the orders table keeps
    // only a hash of the cart.
    expect(lines).toEqual([{ sku: "QC_OLIVEOIL_500ML", qty: 1, line_total_cents: dollars(880) }]);
    h.store.close();
  });

  it("the inventory race itself is settled before anyone pays", async () => {
    const h = harness();

    const first = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_race_a",
      proposal: offerOf("QC_OLIVEOIL_500ML", 1, dollars(880)),
    });
    const second = await h.engine.propose({
      mandate_id: "mnd_test",
      session_id: "ses_race_b",
      proposal: offerOf("QC_OLIVEOIL_500ML", 1, dollars(880)),
    });

    expect(first.kind).toBe("AUTHORISED");
    expect(second.kind).toBe("DENIED");
    if (second.kind !== "DENIED") throw new Error("unreachable");
    expect(second.rule_id).toBe("INVENTORY.INSUFFICIENT");

    // Exactly one order exists, and the loser made no rail call.
    expect(h.ledger.byEventType("ORDER_CREATED").length).toBe(1);
    expect(h.ledger.byEventType("INVENTORY_CONFLICT").length).toBe(1);
    h.store.close();
  });
});

/* ------------------------------------------------------------- F4 / F5 --- */

/**
 * The webhook path, at the Engine.
 *
 * `WebhookGate` already had unit tests for signature and dedupe. What was never
 * covered is the half that matters to an order: an accepted event changing
 * payment state, a rejected one changing nothing, and a late event failing to
 * wind a captured payment backwards.
 */

/** A Stripe-shaped delivery for a payment on a known order. */
function deliveryOf(
  rail: FixtureRail,
  args: { paymentId: string; orderId: string; status: "authorized" | "captured"; amount: number; eventId: string },
): { body: string; signature: string } {
  const body = JSON.stringify({
    id: args.eventId,
    object: "event",
    type: args.status === "captured" ? "charge.captured" : "charge.succeeded",
    livemode: false,
    data: {
      object: {
        id: args.paymentId,
        object: "charge",
        amount: args.amount,
        currency: "usd",
        status: "succeeded",
        captured: args.status === "captured",
        payment_intent: args.orderId,
        payment_method: TEST_PM_SUCCESS,
        payment_method_details: { type: "card" },
        created: 1_700_000_000,
      },
    },
    created: 1_700_000_000,
  });
  return { body, signature: rail.signWebhook(body) };
}

/** An allowed, unpaid order: payment state starts at `created`. */
async function orderFor(h: ReturnType<typeof harness>): Promise<string> {
  const result = await h.engine.propose({
    mandate_id: "mnd_test",
    proposal: offerOf("QC_OLIVEOIL_500ML", 1, dollars(900)),
    session_id: "sess_webhook",
  });
  if (result.kind === "DENIED") throw new Error("setup failed: the gate denied the fixture cart");
  return result.order_id;
}

describe("F4: a forged webhook", () => {
  it("is rejected and leaves payment state untouched", async () => {
    const h = harness();
    const orderId = await orderFor(h);
    const genuine = deliveryOf(h.rail, {
      paymentId: "ch_forge",
      orderId,
      status: "captured",
      amount: dollars(900),
      eventId: "evt_forged",
    });

    const verdict = h.engine.handleWebhook(genuine.body, {
      "stripe-signature": `${genuine.signature.slice(0, -2)}00`,
    });

    expect(verdict.kind).toBe("REJECTED_SIGNATURE");
    expect(h.store.getOrder(orderId)?.payment_status).toBe("created");
    expect(h.ledger.byEventType("WEBHOOK_REJECTED")).toHaveLength(1);
    expect(h.ledger.byEventType("WEBHOOK_ACCEPTED")).toHaveLength(0);
  });

  it("does not consume the event id, so the genuine delivery still processes", async () => {
    const h = harness();
    const orderId = await orderFor(h);
    const genuine = deliveryOf(h.rail, {
      paymentId: "ch_forge",
      orderId,
      status: "captured",
      amount: dollars(900),
      eventId: "evt_same",
    });

    h.engine.handleWebhook(`${genuine.body} `, { "stripe-signature": genuine.signature });
    const accepted = h.engine.handleWebhook(genuine.body, { "stripe-signature": genuine.signature });

    expect(accepted.kind).toBe("ACCEPTED");
    expect(h.store.getOrder(orderId)?.payment_status).toBe("captured");
  });
});

describe("F5: out-of-order and duplicate webhooks", () => {
  it("converges when captured arrives before authorized", async () => {
    const h = harness();
    const orderId = await orderFor(h);
    const args = { paymentId: "ch_ooo", orderId, amount: dollars(900) };

    const captured = deliveryOf(h.rail, { ...args, status: "captured", eventId: "evt_captured" });
    h.engine.handleWebhook(captured.body, { "stripe-signature": captured.signature });
    expect(h.store.getOrder(orderId)?.payment_status).toBe("captured");

    const late = deliveryOf(h.rail, { ...args, status: "authorized", eventId: "evt_authorized" });
    const verdict = h.engine.handleWebhook(late.body, { "stripe-signature": late.signature });

    // Accepted as a genuine event, and then deliberately not applied.
    expect(verdict.kind).toBe("ACCEPTED");
    expect(h.store.getOrder(orderId)?.payment_status).toBe("captured");
  });

  it("treats a replayed event id as a no-op", async () => {
    const h = harness();
    const orderId = await orderFor(h);
    const captured = deliveryOf(h.rail, {
      paymentId: "ch_dupe",
      orderId,
      status: "captured",
      amount: dollars(900),
      eventId: "evt_once",
    });
    const headers = { "stripe-signature": captured.signature };

    expect(h.engine.handleWebhook(captured.body, headers).kind).toBe("ACCEPTED");
    expect(h.engine.handleWebhook(captured.body, headers).kind).toBe("DUPLICATE");
    expect(h.ledger.byEventType("WEBHOOK_DEDUPED")).toHaveLength(1);
    expect(h.store.getOrder(orderId)?.payment_status).toBe("captured");
  });

  it("records but does not apply an event for an order it does not have", () => {
    const h = harness();
    const stranger = deliveryOf(h.rail, {
      paymentId: "ch_stranger",
      orderId: "pi_not_ours",
      status: "captured",
      amount: dollars(100),
      eventId: "evt_stranger",
    });

    const verdict = h.engine.handleWebhook(stranger.body, { "stripe-signature": stranger.signature });

    expect(verdict.kind).toBe("ACCEPTED");
    const entry = h.ledger.byEventType("WEBHOOK_ACCEPTED")[0];
    expect((entry?.detail as { applied?: boolean } | undefined)?.applied).toBe(false);
  });
});


/* --------------------------------------------------------- Route (B2B) --- */

/**
 * Split settlement.
 *
 * The B2B vertical sells other people's goods: one cart, one payment, several
 * suppliers. These tests are about the property that makes that safe to
 * automate -- the transfers sum to exactly what was captured, every time, with
 * the platform's commission taken off the top rather than out of a supplier.
 */

const B2B_PROFILE: MerchantProfile = {
  merchant_id: "mch_bulk",
  display_name: "Harbor Wholesale Supply",
  vertical: "b2b_procurement",
  min_margin_bps: 800,
  max_discount_bps: 3_500,
  levers: ["bulk_tier", "substitute"],
  category_taxonomy: ["staples", "packaging"],
  settlement: { mode: "route", commission_bps: 200, commission_account_id: "acc_PLATFORM" },
};

const WS_COFFEE: CatalogItem = {
  sku: "WS_COFFEE_5LB",
  merchant_id: "mch_bulk",
  title: "Whole Bean Coffee 5lb",
  category: "staples",
  unit: "sack",
  list_cents: dollars(2_800),
  cost_cents: dollars(2_200),
  stock: 50,
  moq: 1,
  supplier_account_id: "acc_GRAINS",
};

const WS_CUPS: CatalogItem = {
  sku: "WS_CUPS_1000",
  merchant_id: "mch_bulk",
  title: "Paper Cups 12oz (1000 ct)",
  category: "packaging",
  unit: "carton",
  list_cents: dollars(1_600),
  cost_cents: dollars(1_250),
  stock: 50,
  moq: 1,
  supplier_account_id: "acc_PACKAGING",
};

function b2bHarness() {
  const store = Store.open(":memory:");
  const ledger = Ledger.open(":memory:");
  const rail = new FixtureRail({ now: () => 1_700_000_000_000 });
  const mandate = mandateOf({
    mandate_id: "mnd_b2b",
    vertical: "b2b_procurement",
    reserved_cents: dollars(500_000),
    max_per_txn_cents: dollars(200_000),
    requires_human_approval_above_cents: dollars(200_000),
    scope: { merchant_allowlist: ["mch_bulk"], category_allowlist: ["staples", "packaging"] },
  });

  store.putMerchant(B2B_PROFILE);
  for (const i of [WS_COFFEE, WS_CUPS]) store.putItem(i);
  store.putPrincipal(mandate.principal_id, KEYS.publicKey);
  store.putMandate({
    mandate,
    signature: signValue(mandate, KEYS.privateKey),
    public_key: KEYS.publicKey,
  });

  return { store, ledger, rail, engine: new Engine({ store, ledger, rail }) };
}

/** A two-supplier cart: coffee from the food supplier, cups from packaging. */
function mixedCart(): Proposal {
  return {
    merchant_id: "mch_bulk",
    lines: [
      { sku: "WS_COFFEE_5LB", qty: 3, offer_unit_cents: dollars(2_800) },
      { sku: "WS_CUPS_1000", qty: 2, offer_unit_cents: dollars(1_600) },
    ],
    quoted_total_cents: dollars(3 * 2_800 + 2 * 1_600),
    rationale: "test",
  };
}

describe("Route: splitting a captured payment across suppliers", () => {
  it("transfers sum to exactly the captured amount", async () => {
    const h = b2bHarness();
    const result = await h.engine.propose({
      mandate_id: "mnd_b2b",
      proposal: mixedCart(),
      session_id: "sess_route",
    });
    if (result.kind !== "AUTHORISED") throw new Error(`expected AUTHORISED, got ${result.kind}`);

    const settled = await h.engine.settle({
      order_id: result.order_id,
      token_id: result.token.token_id,
      session_id: "sess_route",
    });
    if (settled.kind !== "CAPTURED") throw new Error(`expected CAPTURED, got ${settled.kind}`);

    const transfers = await h.rail.fetchTransfers(settled.payment_id);
    const total = transfers.reduce((a, t) => a + t.amount, 0);
    expect(total).toBe(settled.amount);
    expect(transfers.map((t) => t.recipient).sort()).toEqual([
      "acc_GRAINS",
      "acc_PACKAGING",
      "acc_PLATFORM",
    ]);
  });

  it("takes the commission off the top, not out of a supplier's share", async () => {
    const h = b2bHarness();
    const result = await h.engine.propose({
      mandate_id: "mnd_b2b",
      proposal: mixedCart(),
      session_id: "sess_route",
    });
    if (result.kind !== "AUTHORISED") throw new Error("setup failed");

    const settled = await h.engine.settle({
      order_id: result.order_id,
      token_id: result.token.token_id,
      session_id: "sess_route",
    });
    if (settled.kind !== "CAPTURED") throw new Error("setup failed");

    const transfers = await h.rail.fetchTransfers(settled.payment_id);
    const commission = transfers.find((t) => t.recipient === "acc_PLATFORM");
    expect(commission?.amount).toBe(Math.floor((settled.amount * 200) / 10_000));

    // Suppliers divide what is left in proportion to what each actually sold.
    const suppliers = transfers.filter((t) => t.recipient !== "acc_PLATFORM");
    const distributable = settled.amount - (commission?.amount ?? 0);
    expect(suppliers.reduce((a, t) => a + t.amount, 0)).toBe(distributable);

    const grains = transfers.find((t) => t.recipient === "acc_GRAINS")?.amount ?? 0;
    const packaging = transfers.find((t) => t.recipient === "acc_PACKAGING")?.amount ?? 0;
    expect(grains).toBeGreaterThan(packaging);
  });

  it("records the split in the ledger with every leg", async () => {
    const h = b2bHarness();
    const result = await h.engine.propose({
      mandate_id: "mnd_b2b",
      proposal: mixedCart(),
      session_id: "sess_route",
    });
    if (result.kind !== "AUTHORISED") throw new Error("setup failed");

    await h.engine.settle({
      order_id: result.order_id,
      token_id: result.token.token_id,
      session_id: "sess_route",
    });

    const entries = h.ledger.byEventType("SETTLEMENT_SPLIT");
    expect(entries).toHaveLength(1);
    const detail = entries[0]?.detail as {
      legs?: { account: string; amount_cents: number }[];
      commission_cents?: number;
      captured_cents?: number;
    };
    expect(detail.legs).toHaveLength(3);
    expect(detail.legs?.reduce((a, l) => a + l.amount_cents, 0)).toBe(detail.captured_cents);
  });

  it("does not split a merchant's own inventory", async () => {
    // Quick-commerce sells what it owns: no line names a supplier, no profile
    // names a settlement, so nothing transfers. Same code path, different data.
    const h = harness();
    const result = await h.engine.propose({
      mandate_id: "mnd_test",
      proposal: offerOf("QC_OLIVEOIL_500ML", 1, dollars(900)),
      session_id: "sess_own",
    });
    if (result.kind !== "AUTHORISED") throw new Error("setup failed");

    const settled = await h.engine.settle({
      order_id: result.order_id,
      token_id: result.token.token_id,
      session_id: "sess_own",
    });
    if (settled.kind !== "CAPTURED") throw new Error("setup failed");

    expect(await h.rail.fetchTransfers(settled.payment_id)).toEqual([]);
    expect(h.ledger.byEventType("SETTLEMENT_SPLIT")).toHaveLength(0);
  });

  it("keeps the capture when a transfer fails, and says so in the ledger", async () => {
    const h = b2bHarness();
    const result = await h.engine.propose({
      mandate_id: "mnd_b2b",
      proposal: mixedCart(),
      session_id: "sess_route",
    });
    if (result.kind !== "AUTHORISED") throw new Error("setup failed");

    // The rail refuses every split from here on.
    h.rail.createTransfers = async () => {
      throw new Error("linked account is not activated");
    };

    const settled = await h.engine.settle({
      order_id: result.order_id,
      token_id: result.token.token_id,
      session_id: "sess_route",
    });

    // The buyer paid and the goods are theirs; a stuck payout is an operator's
    // problem, not a reason to reverse a payment that succeeded.
    expect(settled.kind).toBe("CAPTURED");
    const entry = h.ledger.byEventType("SETTLEMENT_SPLIT")[0];
    expect((entry?.detail as { failed?: boolean } | undefined)?.failed).toBe(true);
  });
});
