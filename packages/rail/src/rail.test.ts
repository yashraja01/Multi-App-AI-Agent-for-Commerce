import { describe, expect, it } from "vitest";
import { cents } from "@mercury/core";
import { FixtureRail, RailError } from "./fixture.js";
import { chargeOf, paymentFromCharge } from "./shapes.js";
import { parseSignatureHeader, signWebhookHeader, verifyWebhookSignature } from "./signatures.js";
import { StripeRail, form } from "./stripe.js";
import { TEST_PM_DECLINED, TEST_PM_SUCCESS } from "./types.js";
import { InMemorySeenEvents, WebhookGate, advanceStatus, normalise } from "./webhook.js";

const NOW = 1_780_000_000;

function rail(): FixtureRail {
  return new FixtureRail({ webhookSecret: "whsec_test", now: () => NOW });
}

async function anOrder(r: FixtureRail, amount = 55_000) {
  return r.createOrder({
    amount: cents(amount),
    receipt: "mrc_itk_test_1",
    notes: { mandate_id: "mnd_1", ledger_seq: "7" },
  });
}

describe("orders", () => {
  it("creates an order with deterministic ids and cents amounts", async () => {
    const r = rail();
    const o = await anOrder(r);
    expect(o.id).toBe("pi_FIX0000001");
    expect(o.amount).toBe(55_000);
    expect(o.amount_due).toBe(55_000);
    expect(o.currency).toBe("USD");
    expect(o.status).toBe("created");
  });

  it("carries the Mercury audit trail in notes, so an order traces back to its mandate", async () => {
    const r = rail();
    const o = await anOrder(r);
    expect(o.notes["mandate_id"]).toBe("mnd_1");
    expect(o.notes["ledger_seq"]).toBe("7");
  });

  it("enforces the receipt limit of 40 characters", async () => {
    const r = rail();
    await expect(
      r.createOrder({ amount: cents(100), receipt: "x".repeat(41), notes: {} }),
    ).rejects.toThrow(RailError);
  });

  it("enforces the notes limits (15 pairs, 256 chars)", async () => {
    const r = rail();
    const many = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"]));
    await expect(r.createOrder({ amount: cents(100), receipt: "r", notes: many })).rejects.toThrow(
      /15 key-value/,
    );
    await expect(
      r.createOrder({ amount: cents(100), receipt: "r", notes: { k: "v".repeat(257) } }),
    ).rejects.toThrow(/256/);
  });
});

describe("payment attempts mirror Stripe test mode", () => {
  it("pm_card_visa authorises the payment", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment, failed } = await r.attemptPayment(o.id, TEST_PM_SUCCESS);
    expect(failed).toBe(false);
    expect(payment.id).toMatch(/^ch_FIX/u);
    expect(payment.status).toBe("authorized");
    expect(payment.captured).toBe(false);
    expect(payment.payment_method).toBe(TEST_PM_SUCCESS);
    expect((await r.fetchOrder(o.id))?.status).toBe("attempted");
  });

  it("pm_card_chargeDeclined fails the payment with a Stripe-shaped error", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment, failed } = await r.attemptPayment(o.id, TEST_PM_DECLINED);
    expect(failed).toBe(true);
    expect(payment.status).toBe("failed");
    expect(payment.error_code).toBe("card_declined");
  });

  it("refuses to capture a failed payment", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.attemptPayment(o.id, TEST_PM_DECLINED);
    await expect(r.capturePayment(payment.id, cents(55_000))).rejects.toThrow(/failed/);
  });

  it("capture is idempotent and marks the order paid", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.attemptPayment(o.id, TEST_PM_SUCCESS);
    const c1 = await r.capturePayment(payment.id, cents(55_000));
    const c2 = await r.capturePayment(payment.id, cents(55_000));
    expect(c1.status).toBe("captured");
    expect(c2).toEqual(c1);
    const order = await r.fetchOrder(o.id);
    expect(order?.status).toBe("paid");
    expect(order?.amount_due).toBe(0);
  });
});

describe("refunds -- the compensating transaction for F3", () => {
  it("refunds a captured payment", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.attemptPayment(o.id, TEST_PM_SUCCESS);
    await r.capturePayment(payment.id, cents(55_000));
    const refund = await r.refund(payment.id, cents(55_000), { reason: "INVENTORY_CONFLICT" });
    expect(refund.id).toMatch(/^re_FIX/u);
    expect(refund.status).toBe("processed");
    expect((await r.fetchPayment(payment.id))?.status).toBe("refunded");
  });

  it("refuses to refund a payment that was never captured", async () => {
    const r = rail();
    const o = await anOrder(r);
    const { payment } = await r.attemptPayment(o.id, TEST_PM_SUCCESS);
    await expect(r.refund(payment.id, cents(55_000))).rejects.toThrow(/captured/);
  });
});

describe("Stripe signature scheme", () => {
  it("signs t=...,v1=... over timestamp.body", () => {
    const header = signWebhookHeader("{}", "whsec_x", NOW);
    expect(header).toMatch(/^t=1780000000,v1=[0-9a-f]{64}$/u);
    expect(verifyWebhookSignature("{}", header, "whsec_x", { now: () => NOW })).toEqual({ ok: true });
  });

  it("rejects a header made with the wrong secret", () => {
    const header = signWebhookHeader("{}", "whsec_other", NOW);
    expect(verifyWebhookSignature("{}", header, "whsec_x", { now: () => NOW }).ok).toBe(false);
  });

  it("rejects a delivery outside the tolerance window, even with a genuine HMAC", () => {
    const header = signWebhookHeader("{}", "whsec_x", NOW - 3600);
    const v = verifyWebhookSignature("{}", header, "whsec_x", { now: () => NOW });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toMatch(/tolerance/);
  });

  it("accepts any one of several v1 values, as during secret rotation", () => {
    const good = signWebhookHeader("{}", "whsec_x", NOW).split(",")[1];
    const header = `t=${NOW},v1=${"0".repeat(64)},${good}`;
    expect(verifyWebhookSignature("{}", header, "whsec_x", { now: () => NOW })).toEqual({ ok: true });
  });

  it("parses malformed headers to undefined without throwing", () => {
    expect(parseSignatureHeader("garbage")).toBeUndefined();
    expect(parseSignatureHeader("t=abc,v1=zz")).toBeUndefined();
    expect(parseSignatureHeader("v1=abcd")).toBeUndefined();
  });
});

describe("webhook gate", () => {
  async function delivery() {
    const r = rail();
    const o = await anOrder(r);
    await r.attemptPayment(o.id, TEST_PM_SUCCESS);
    const d = r.deliveryFor("charge.succeeded");
    if (d === undefined) throw new Error("no delivery emitted");
    return { r, ...d };
  }

  it("accepts a genuine delivery and normalises it", async () => {
    const { r, body, signature, event_id } = await delivery();
    const gate = new WebhookGate(r);
    const v = gate.handle(body, { "stripe-signature": signature });
    expect(v.kind).toBe("ACCEPTED");
    if (v.kind !== "ACCEPTED") throw new Error("unreachable");
    expect(v.event_id).toBe(event_id);
    expect(v.event.event).toBe("payment.authorized");
    expect(v.event.provider_type).toBe("charge.succeeded");
    expect(v.event.payload.payment?.entity.status).toBe("authorized");
  });

  /* ------------------------------------------------------------------ F4 */

  it("F4: rejects a forged signature and never parses the body", async () => {
    const { r, body } = await delivery();
    const gate = new WebhookGate(r);
    const v = gate.handle(body, { "stripe-signature": `t=${NOW},v1=${"ab".repeat(32)}` });
    expect(v.kind).toBe("REJECTED_SIGNATURE");
  });

  it("F4: rejects a body that was altered after signing", async () => {
    const { r, body, signature } = await delivery();
    const gate = new WebhookGate(r);
    const tampered = body.replace('"amount":55000', '"amount":5');
    expect(tampered).not.toBe(body);
    const v = gate.handle(tampered, { "stripe-signature": signature });
    expect(v.kind).toBe("REJECTED_SIGNATURE");
  });

  it("F4: rejects a missing signature header", async () => {
    const { r, body } = await delivery();
    const v = new WebhookGate(r).handle(body, {});
    expect(v.kind).toBe("REJECTED_SIGNATURE");
  });

  it("F4: a forged delivery leaves the genuine one still processable", async () => {
    const { r, body, signature } = await delivery();
    const gate = new WebhookGate(r);
    expect(gate.handle(body, { "stripe-signature": `t=${NOW},v1=${"00".repeat(32)}` }).kind).toBe(
      "REJECTED_SIGNATURE",
    );
    expect(gate.handle(body, { "stripe-signature": signature }).kind).toBe("ACCEPTED");
  });

  /* ------------------------------------------------------------------ F5 */

  it("F5: deduplicates a retried delivery on the event id inside the body", async () => {
    const { r, body, signature, event_id } = await delivery();
    const gate = new WebhookGate(r, new InMemorySeenEvents());
    expect(gate.handle(body, { "stripe-signature": signature }).kind).toBe("ACCEPTED");
    const again = gate.handle(body, { "stripe-signature": signature });
    expect(again).toEqual({ kind: "DUPLICATE", event_id });
  });

  it("rejects a validly-signed body that is not a Stripe event", async () => {
    const r = rail();
    const body = JSON.stringify({ hello: "world" });
    const v = new WebhookGate(r).handle(body, { "stripe-signature": r.signWebhook(body) });
    expect(v.kind).toBe("REJECTED_MALFORMED");
  });

  it("rejects a validly-signed event of a type Mercury does not handle", async () => {
    const r = rail();
    const body = JSON.stringify({
      id: "evt_x",
      object: "event",
      type: "customer.created",
      livemode: false,
      data: { object: { id: "cus_1", object: "customer" } },
      created: NOW,
    });
    const v = new WebhookGate(r).handle(body, { "stripe-signature": r.signWebhook(body) });
    expect(v.kind).toBe("REJECTED_MALFORMED");
  });
});

describe("normalisation", () => {
  it("maps charge.succeeded with captured:true to payment.captured", () => {
    const ch = chargeOf({
      id: "ch_1",
      entity: "payment",
      amount: 100,
      currency: "USD",
      status: "captured",
      order_id: "pi_1",
      method: "card",
      captured: true,
      created_at: NOW,
    });
    const env = normalise({
      id: "evt_1",
      object: "event",
      type: "charge.succeeded",
      livemode: false,
      data: { object: ch as unknown as Record<string, unknown> },
      created: NOW,
    });
    expect(env?.event).toBe("payment.captured");
  });

  it("round-trips a payment through Stripe's charge shape", () => {
    const original = {
      id: "ch_2",
      entity: "payment" as const,
      amount: 4_200,
      currency: "USD" as const,
      status: "failed" as const,
      order_id: "pi_2",
      method: "card" as const,
      payment_method: TEST_PM_DECLINED,
      captured: false,
      error_code: "card_declined",
      error_description: "Your card was declined.",
      created_at: NOW,
    };
    expect(paymentFromCharge(chargeOf(original))).toEqual(original);
  });

  it("carries a refund out of charge.refunded", () => {
    const ch = chargeOf({
      id: "ch_3",
      entity: "payment",
      amount: 900,
      currency: "USD",
      status: "refunded",
      order_id: "pi_3",
      method: "card",
      captured: true,
      created_at: NOW,
    });
    const env = normalise({
      id: "evt_3",
      object: "event",
      type: "charge.refunded",
      livemode: false,
      data: { object: ch as unknown as Record<string, unknown> },
      created: NOW,
    });
    expect(env?.event).toBe("refund.processed");
    expect(env?.payload.refund?.entity.payment_id).toBe("ch_3");
    expect(env?.payload.payment?.entity.status).toBe("refunded");
  });
});

describe("F5: payment status advances monotonically", () => {
  it("captured arriving before authorized still converges to captured", () => {
    expect(advanceStatus("created", "captured")).toBe("captured");
    expect(advanceStatus("captured", "authorized")).toBe("captured");
  });

  it("never regresses on replay", () => {
    expect(advanceStatus("captured", "captured")).toBe("captured");
    expect(advanceStatus("refunded", "captured")).toBe("refunded");
  });

  it("advances to refunded and stays there", () => {
    expect(advanceStatus("captured", "refunded")).toBe("refunded");
    expect(advanceStatus("refunded", "authorized")).toBe("refunded");
  });
});

describe("StripeRail", () => {
  it("refuses a key that is not test mode", () => {
    expect(() => new StripeRail({ secretKey: "sk_live_abc", webhookSecret: "w" })).toThrow(/test mode/);
  });

  it("accepts a test key", () => {
    expect(() => new StripeRail({ secretKey: "sk_test_abc", webhookSecret: "w" })).not.toThrow();
  });

  it("shares signature semantics with FixtureRail", () => {
    const live = new StripeRail({ secretKey: "sk_test_abc", webhookSecret: "whsec_test", now: () => NOW });
    const header = signWebhookHeader("{}", "whsec_test", NOW);
    expect(live.verifyWebhookSignature("{}", header)).toEqual({ ok: true });
    expect(rail().verifyWebhookSignature("{}", header)).toEqual({ ok: true });
  });

  it("encodes nested params in Stripe's bracket form", () => {
    const encoded = form({ amount: 100, currency: "usd", metadata: { order_id: "o_1" }, "expand[]": "latest_charge" });
    expect(decodeURIComponent(encoded)).toBe("amount=100&currency=usd&metadata[order_id]=o_1&expand[]=latest_charge");
  });

  it("creates an intent with manual capture and treats a 402 decline as a failed attempt, not a throw", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const body = String(init?.body ?? "");
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/payment_intents")) {
        return new Response(
          JSON.stringify({
            id: "pi_live_1",
            object: "payment_intent",
            amount: 1_160,
            amount_received: 0,
            currency: "usd",
            status: "requires_payment_method",
            description: "mrc_itk_1",
            metadata: { mandate_id: "mnd_1" },
            created: NOW,
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith("/confirm")) {
        return new Response(
          JSON.stringify({
            error: {
              type: "card_error",
              code: "card_declined",
              decline_code: "generic_decline",
              message: "Your card was declined.",
              charge: "ch_live_declined",
            },
          }),
          { status: 402 },
        );
      }
      if (String(url).endsWith("/charges/ch_live_declined")) {
        return new Response(
          JSON.stringify({
            id: "ch_live_declined",
            object: "charge",
            amount: 1_160,
            currency: "usd",
            status: "failed",
            captured: false,
            payment_intent: "pi_live_1",
            payment_method: TEST_PM_DECLINED,
            payment_method_details: { type: "card" },
            failure_code: "card_declined",
            failure_message: "Your card was declined.",
            created: NOW,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    };

    const live = new StripeRail({ secretKey: "sk_test_abc", webhookSecret: "w", fetchImpl, now: () => NOW });
    const order = await live.createOrder({ amount: cents(1_160), receipt: "mrc_itk_1", notes: { mandate_id: "mnd_1" } });
    expect(order.id).toBe("pi_live_1");
    expect(order.status).toBe("created");
    expect(decodeURIComponent(calls[0]?.body ?? "")).toContain("capture_method=manual");
    expect(decodeURIComponent(calls[0]?.body ?? "")).toContain("metadata[mandate_id]=mnd_1");

    const attempt = await live.attemptPayment(order.id, TEST_PM_DECLINED);
    expect(attempt.failed).toBe(true);
    expect(attempt.payment.status).toBe("failed");
    expect(attempt.payment.error_code).toBe("card_declined");
  });
});
