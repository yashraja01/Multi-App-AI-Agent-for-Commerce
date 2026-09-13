import { type Cents, cents } from "@mercury/core";
import { chargeOf, intentOf, stripeTransferOf, type StripeEvent } from "./shapes.js";
import { signWebhookHeader, verifyWebhookSignature } from "./signatures.js";
import {
  type OrderInput,
  type PaymentAttempt,
  type PaymentLinkInput,
  type PaymentPort,
  type RailOrder,
  type RailPayment,
  type RailPaymentLink,
  type RailRefund,
  type RailTransfer,
  TEST_PM_DECLINED,
  type TransferInput,
} from "./types.js";

/**
 * FixtureRail -- Stripe, recorded.
 *
 * Reproduces the response shapes and lifecycle of Stripe test mode with no
 * network, no account and no tunnel. Every id is deterministic, so a test that
 * passes once passes identically forever.
 *
 * It earns its place beyond convenience: all seven engineered failures --
 * including the forged webhook and the out-of-order delivery -- are
 * reproducible here, which they would not be against a live endpoint. The
 * webhook bodies it emits are in Stripe's own shape and signed the way Stripe
 * signs, so a delivery built here is indistinguishable from a real one.
 *
 * The test payment methods mirror Stripe's:
 *   pm_card_visa            -> authorised
 *   pm_card_chargeDeclined  -> declined, card_declined
 */

export interface FixtureRailOptions {
  webhookSecret?: string;
  /** Fixed clock (unix seconds), so created_at and signatures are deterministic too. */
  now?: () => number;
}

export class FixtureRail implements PaymentPort {
  readonly mode = "fixture" as const;

  readonly #webhookSecret: string;
  readonly #now: () => number;

  #counter = 0;
  readonly #orders = new Map<string, RailOrder>();
  readonly #payments = new Map<string, RailPayment>();
  readonly #refunds = new Map<string, RailRefund>();
  readonly #transfers = new Map<string, RailTransfer[]>();
  readonly #links = new Map<string, RailPaymentLink>();
  readonly #emitted: StripeEvent[] = [];

  constructor(opts: FixtureRailOptions = {}) {
    this.#webhookSecret = opts.webhookSecret ?? "whsec_fixture";
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  #id(prefix: string): string {
    this.#counter += 1;
    return `${prefix}_FIX${String(this.#counter).padStart(7, "0")}`;
  }

  /* ------------------------------------------------------------- port impl */

  async createOrder(input: OrderInput): Promise<RailOrder> {
    if (input.receipt.length > 40) {
      throw new RailError(`receipt exceeds 40 characters: ${input.receipt.length}`);
    }
    if (Object.keys(input.notes).length > 15) {
      throw new RailError("notes may contain at most 15 key-value pairs");
    }
    for (const [k, v] of Object.entries(input.notes)) {
      if (v.length > 256) throw new RailError(`note "${k}" exceeds 256 characters`);
    }

    const order: RailOrder = {
      id: this.#id("pi"),
      entity: "order",
      amount: input.amount,
      amount_paid: 0,
      amount_due: input.amount,
      currency: "USD",
      receipt: input.receipt,
      status: "created",
      attempts: 0,
      notes: input.notes,
      created_at: this.#now(),
    };
    this.#orders.set(order.id, order);
    return order;
  }

  async fetchOrder(orderId: string): Promise<RailOrder | undefined> {
    return this.#orders.get(orderId);
  }

  /**
   * Confirm the intent with a test payment method, exactly as Stripe test mode
   * behaves for that method. Authorises only; `capturePayment` moves the money.
   */
  async attemptPayment(orderId: string, paymentMethod: string): Promise<PaymentAttempt> {
    const order = this.#orders.get(orderId);
    if (order === undefined) throw new RailError(`no such order: ${orderId}`);

    const failed = paymentMethod === TEST_PM_DECLINED;
    const payment: RailPayment = {
      id: this.#id("ch"),
      entity: "payment",
      amount: cents(order.amount),
      currency: "USD",
      status: failed ? "failed" : "authorized",
      order_id: orderId,
      method: "card",
      payment_method: paymentMethod,
      captured: false,
      ...(failed ? { error_code: "card_declined", error_description: "Your card was declined." } : {}),
      created_at: this.#now(),
    };

    this.#payments.set(payment.id, payment);
    this.#orders.set(orderId, { ...order, status: "attempted", attempts: order.attempts + 1 });
    this.#emit(failed ? "charge.failed" : "charge.succeeded", chargeOf(payment));

    return { payment, failed };
  }

  async createPaymentLink(input: PaymentLinkInput): Promise<RailPaymentLink> {
    const link: RailPaymentLink = {
      id: this.#id("plink"),
      entity: "payment_link",
      amount: input.amount,
      currency: "USD",
      status: "created",
      url: `https://buy.stripe.com/test_FIX${this.#counter}`,
      reference_id: input.reference_id,
      notes: input.notes,
      created_at: this.#now(),
    };
    this.#links.set(link.id, link);
    return link;
  }

  async fetchPayment(paymentId: string): Promise<RailPayment | undefined> {
    return this.#payments.get(paymentId);
  }

  async capturePayment(paymentId: string, amount: Cents): Promise<RailPayment> {
    const p = this.#payments.get(paymentId);
    if (p === undefined) throw new RailError(`no such payment: ${paymentId}`);
    if (p.status === "failed") throw new RailError(`cannot capture a failed payment: ${paymentId}`);
    if (p.status === "captured") return p; // idempotent

    const captured: RailPayment = { ...p, status: "captured", captured: true, amount };
    this.#payments.set(paymentId, captured);

    const order = this.#orders.get(p.order_id);
    if (order !== undefined) {
      const paid: RailOrder = {
        ...order,
        status: "paid",
        amount_paid: amount,
        amount_due: Math.max(0, order.amount - amount),
      };
      this.#orders.set(order.id, paid);
      this.#emit("payment_intent.succeeded", intentOf(paid));
    }

    this.#emit("charge.captured", chargeOf(captured));
    return captured;
  }

  async refund(
    paymentId: string,
    amount: Cents,
    notes: Record<string, string> = {},
  ): Promise<RailRefund> {
    const p = this.#payments.get(paymentId);
    if (p === undefined) throw new RailError(`no such payment: ${paymentId}`);
    if (p.status !== "captured") {
      throw new RailError(`can only refund a captured payment; ${paymentId} is ${p.status}`);
    }

    const r: RailRefund = {
      id: this.#id("re"),
      entity: "refund",
      amount,
      currency: "USD",
      payment_id: paymentId,
      status: "processed",
      notes,
      created_at: this.#now(),
    };
    this.#refunds.set(r.id, r);
    const refunded: RailPayment = { ...p, status: "refunded" };
    this.#payments.set(paymentId, refunded);
    // Stripe reports a refund as `charge.refunded` carrying the charge itself.
    this.#emit("charge.refunded", chargeOf(refunded));
    return r;
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string): { ok: true } | { ok: false; reason: string } {
    return verifyWebhookSignature(rawBody, signatureHeader, this.#webhookSecret, { now: this.#now });
  }

  /* --------------------------------------------------------- split settlement */

  async createTransfers(
    paymentId: string,
    transfers: readonly TransferInput[],
  ): Promise<RailTransfer[]> {
    const payment = this.#payments.get(paymentId);
    if (payment === undefined) throw new RailError(`no such payment: ${paymentId}`);
    if (payment.status !== "captured") {
      throw new RailError(`cannot transfer from a payment that is ${payment.status}`);
    }

    const already = (this.#transfers.get(paymentId) ?? []).reduce((a, t) => a + t.amount, 0);
    const asked = transfers.reduce((a, t) => a + t.amount, 0);
    if (already + asked > payment.amount) {
      throw new RailError(
        `transfers exceed the captured amount: ${already + asked} > ${payment.amount}`,
      );
    }

    const made = transfers.map((t) => {
      const transfer: RailTransfer = {
        id: this.#id("tr"),
        entity: "transfer",
        source: paymentId,
        recipient: t.account,
        amount: t.amount,
        currency: "USD",
        status: "processed",
        notes: t.notes,
        created_at: this.#now(),
      };
      this.#emit("transfer.created", stripeTransferOf(transfer));
      return transfer;
    });

    this.#transfers.set(paymentId, [...(this.#transfers.get(paymentId) ?? []), ...made]);
    return made;
  }

  async fetchTransfers(paymentId: string): Promise<RailTransfer[]> {
    return [...(this.#transfers.get(paymentId) ?? [])];
  }

  /* ------------------------------------------------- fixture-only affordances */

  /** Sign a body the way Stripe does -- for constructing genuine test deliveries. */
  signWebhook(rawBody: string, timestamp: number = this.#now()): string {
    return signWebhookHeader(rawBody, this.#webhookSecret, timestamp);
  }

  /** Stripe-shaped events this rail has emitted, oldest first. */
  emitted(): readonly StripeEvent[] {
    return this.#emitted;
  }

  /** The most recent event of a given Stripe type, as a raw body plus a valid signature header. */
  deliveryFor(type: string): { body: string; signature: string; event_id: string } | undefined {
    const found = [...this.#emitted].reverse().find((e) => e.type === type);
    if (found === undefined) return undefined;
    const body = JSON.stringify(found);
    return { body, signature: this.signWebhook(body), event_id: found.id };
  }

  #emit(type: string, object: object): void {
    this.#emitted.push({
      id: this.#id("evt"),
      object: "event",
      type,
      livemode: false,
      data: { object: object as Record<string, unknown> },
      created: this.#now(),
    });
  }
}

export class RailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailError";
  }
}
