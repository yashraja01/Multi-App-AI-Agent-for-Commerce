import type { Cents } from "@mercury/core";
import { RailError } from "./fixture.js";
import {
  type StripeCharge,
  type StripePaymentIntent,
  type StripePaymentLink,
  type StripeRefund,
  type StripeTransfer,
  linkFromStripe,
  orderFromIntent,
  paymentFromCharge,
  refundFromStripe,
  transferFromStripe,
} from "./shapes.js";
import { verifyWebhookSignature } from "./signatures.js";
import type {
  OrderInput,
  PaymentAttempt,
  PaymentLinkInput,
  PaymentPort,
  RailOrder,
  RailPayment,
  RailPaymentLink,
  RailRefund,
  RailTransfer,
  TransferInput,
} from "./types.js";

/**
 * StripeRail -- the real Stripe API, test mode only.
 *
 * Same interface as FixtureRail, so nothing above the port changes when
 * RAIL_MODE flips. Guarded so it refuses to start against a live key: this
 * project is never meant to touch production credentials.
 *
 * How Mercury's lifecycle maps onto Stripe's:
 *
 *   createOrder      -> POST /payment_intents   capture_method=manual
 *   attemptPayment   -> POST /payment_intents/:id/confirm   payment_method=pm_...
 *                       (authorises; a decline comes back as a card_error, not a throw)
 *   capturePayment   -> POST /payment_intents/:id/capture
 *   refund           -> POST /refunds   charge=ch_...
 *   createTransfers  -> POST /transfers destination=acct_...  source_transaction=ch_...
 *   createPaymentLink-> POST /payment_links  (a hosted page for the human step-up)
 *
 * Manual capture is the point: it is what gives the engine a real
 * authorise-then-capture seam, so "verified, then captured" is a fact about
 * the rail rather than a story told about it.
 */

const API = "https://api.stripe.com/v1";

export interface StripeRailOptions {
  secretKey: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface StripeErrorBody {
  error?: {
    type?: string;
    code?: string;
    decline_code?: string;
    message?: string;
    charge?: string;
    payment_intent?: StripePaymentIntent;
  };
}

export class StripeRail implements PaymentPort {
  readonly mode = "live" as const;

  readonly #secretKey: string;
  readonly #webhookSecret: string;
  readonly #fetch: typeof fetch;
  readonly #now: (() => number) | undefined;

  constructor(opts: StripeRailOptions) {
    if (!opts.secretKey.startsWith("sk_test_") && !opts.secretKey.startsWith("rk_test_")) {
      throw new RailError(
        `StripeRail refuses a key that is not test mode: "${opts.secretKey.slice(0, 8)}...". ` +
          `Mercury is a test-mode project by design.`,
      );
    }
    this.#secretKey = opts.secretKey;
    this.#webhookSecret = opts.webhookSecret;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now;
  }

  /* ------------------------------------------------------------ transport */

  async #call<T>(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, unknown>,
    opts: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const body = params === undefined ? undefined : form(params);
    const res = await this.#fetch(`${API}${path}${method === "GET" && body !== undefined ? `?${body}` : ""}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(opts.idempotencyKey === undefined ? {} : { "Idempotency-Key": opts.idempotencyKey }),
      },
      ...(method === "POST" && body !== undefined ? { body } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      const parsed = safeJson(text) as StripeErrorBody | undefined;
      throw new StripeApiError(
        `Stripe ${method} ${path} -> ${res.status}: ${parsed?.error?.message ?? text.slice(0, 200)}`,
        res.status,
        parsed?.error ?? {},
      );
    }
    return JSON.parse(text) as T;
  }

  /* ------------------------------------------------------------- port impl */

  async createOrder(input: OrderInput): Promise<RailOrder> {
    if (input.receipt.length > 40) {
      throw new RailError(`receipt exceeds 40 characters: ${input.receipt.length}`);
    }
    const pi = await this.#call<StripePaymentIntent>(
      "POST",
      "/payment_intents",
      {
        amount: input.amount,
        currency: "usd",
        capture_method: "manual",
        "payment_method_types[]": "card",
        description: input.receipt,
        metadata: input.notes,
      },
      { idempotencyKey: `order_${input.receipt}` },
    );
    return orderFromIntent(pi);
  }

  async fetchOrder(orderId: string): Promise<RailOrder | undefined> {
    try {
      return orderFromIntent(await this.#call<StripePaymentIntent>("GET", `/payment_intents/${orderId}`));
    } catch {
      return undefined;
    }
  }

  async attemptPayment(orderId: string, paymentMethod: string): Promise<PaymentAttempt> {
    try {
      const pi = await this.#call<StripePaymentIntent>("POST", `/payment_intents/${orderId}/confirm`, {
        payment_method: paymentMethod,
        "expand[]": "latest_charge",
      });
      const charge = pi.latest_charge;
      if (charge === undefined || charge === null || typeof charge === "string") {
        throw new RailError(`confirm returned no charge for ${orderId}`);
      }
      const payment = paymentFromCharge(charge);
      return { payment, failed: payment.status === "failed" };
    } catch (e) {
      // A decline is HTTP 402 with a card_error. The failed charge exists, so
      // fetch it and report the attempt rather than throwing: retries and the
      // human fallback are ordinary paths, not exceptions.
      if (e instanceof StripeApiError && e.status === 402 && e.stripe.type === "card_error") {
        const chargeId = e.stripe.charge;
        const payment: RailPayment =
          chargeId === undefined
            ? {
                id: `ch_declined_${orderId}`,
                entity: "payment",
                amount: 0,
                currency: "USD",
                status: "failed",
                order_id: orderId,
                method: "card",
                payment_method: paymentMethod,
                captured: false,
                error_code: e.stripe.decline_code ?? e.stripe.code ?? "card_declined",
                error_description: e.stripe.message ?? "Your card was declined.",
                created_at: this.#now?.() ?? Math.floor(Date.now() / 1000),
              }
            : paymentFromCharge(await this.#call<StripeCharge>("GET", `/charges/${chargeId}`));
        return { payment, failed: true };
      }
      throw e;
    }
  }

  async createPaymentLink(input: PaymentLinkInput): Promise<RailPaymentLink> {
    const link = await this.#call<StripePaymentLink>("POST", "/payment_links", {
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": input.amount,
      "line_items[0][price_data][product_data][name]": input.description.slice(0, 250),
      "line_items[0][quantity]": 1,
      metadata: { ...input.notes, reference_id: input.reference_id },
    });
    return linkFromStripe(link, input.amount, input.reference_id, this.#now?.() ?? Math.floor(Date.now() / 1000));
  }

  async fetchPayment(paymentId: string): Promise<RailPayment | undefined> {
    try {
      return paymentFromCharge(await this.#call<StripeCharge>("GET", `/charges/${paymentId}`));
    } catch {
      return undefined;
    }
  }

  async capturePayment(paymentId: string, amount: Cents): Promise<RailPayment> {
    const charge = await this.#call<StripeCharge>("GET", `/charges/${paymentId}`);
    if (charge.captured) return paymentFromCharge(charge); // idempotent
    if (charge.payment_intent === null) throw new RailError(`charge ${paymentId} has no payment intent`);
    const pi = await this.#call<StripePaymentIntent>(
      "POST",
      `/payment_intents/${charge.payment_intent}/capture`,
      { amount_to_capture: amount, "expand[]": "latest_charge" },
      { idempotencyKey: `capture_${paymentId}` },
    );
    const latest = pi.latest_charge;
    return paymentFromCharge(typeof latest === "object" && latest !== null ? latest : { ...charge, captured: true });
  }

  async refund(paymentId: string, amount: Cents, notes: Record<string, string> = {}): Promise<RailRefund> {
    const r = await this.#call<StripeRefund>(
      "POST",
      "/refunds",
      { charge: paymentId, amount, metadata: notes },
      { idempotencyKey: `refund_${paymentId}_${amount}` },
    );
    return refundFromStripe(r);
  }

  /* --------------------------------------------------------- split settlement */

  /**
   * Split a captured payment across connected accounts.
   *
   * Stripe takes one transfer per call and validates each against the charge's
   * available balance, so a split that exceeds the payment fails on the leg that
   * crosses the line. The engine records each leg as it lands; a failed leg is
   * left for an operator rather than unwinding the capture.
   */
  async createTransfers(paymentId: string, transfers: readonly TransferInput[]): Promise<RailTransfer[]> {
    const made: RailTransfer[] = [];
    for (const [i, t] of transfers.entries()) {
      const tr = await this.#call<StripeTransfer>(
        "POST",
        "/transfers",
        {
          amount: t.amount,
          currency: "usd",
          destination: t.account,
          source_transaction: paymentId,
          transfer_group: paymentId,
          metadata: t.notes,
        },
        { idempotencyKey: `transfer_${paymentId}_${i}` },
      );
      made.push(transferFromStripe(tr));
    }
    return made;
  }

  async fetchTransfers(paymentId: string): Promise<RailTransfer[]> {
    const page = await this.#call<{ data: StripeTransfer[] }>("GET", "/transfers", {
      transfer_group: paymentId,
      limit: 100,
    });
    return page.data.map(transferFromStripe);
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string): { ok: true } | { ok: false; reason: string } {
    return verifyWebhookSignature(rawBody, signatureHeader, this.#webhookSecret, {
      ...(this.#now === undefined ? {} : { now: this.#now }),
    });
  }
}

export class StripeApiError extends RailError {
  constructor(
    message: string,
    readonly status: number,
    readonly stripe: NonNullable<StripeErrorBody["error"]>,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Stripe's API is form-encoded, with nested keys in bracket notation:
 * `metadata[order_id]=...`, `line_items[0][quantity]=1`. Keys that already
 * carry brackets are passed through untouched.
 */
export function form(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix === "" ? k : `${prefix}[${k}]`;
    if (typeof v === "object" && !Array.isArray(v)) {
      parts.push(form(v as Record<string, unknown>, key));
    } else if (Array.isArray(v)) {
      for (const item of v) parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join("&");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
