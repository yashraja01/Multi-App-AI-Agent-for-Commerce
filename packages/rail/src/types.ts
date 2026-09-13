import type { Cents } from "@mercury/core";

/**
 * The rail's entity shapes, narrowed to the fields Mercury actually uses.
 *
 * These are Mercury's own, not the provider's. `StripeRail` maps Stripe's
 * PaymentIntent / Charge / Refund / Transfer into them, and `FixtureRail`
 * produces them directly, so the two are interchangeable: swapping RAIL_MODE
 * must not change a single call site above the port.
 *
 * How the shapes line up with Stripe:
 *
 *   RailOrder        <- PaymentIntent  (pi_...)   the intent to collect an amount
 *   RailPayment      <- Charge         (ch_...)   one attempt against that intent
 *   RailRefund       <- Refund         (re_...)
 *   RailTransfer     <- Transfer       (tr_...)   a Connect payout to a supplier
 *   RailPaymentLink  <- Payment Link   (plink_...) a hosted page a human opens
 */

export type OrderStatus = "created" | "attempted" | "paid";
export type PaymentStatus = "created" | "authorized" | "captured" | "refunded" | "failed";

export interface RailOrder {
  id: string;
  entity: "order";
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: "USD";
  receipt: string;
  status: OrderStatus;
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
}

export interface RailPayment {
  id: string;
  entity: "payment";
  amount: number;
  currency: "USD";
  status: PaymentStatus;
  order_id: string;
  method: "card" | "link" | "bank_transfer";
  /** The payment method that was charged, e.g. `pm_card_visa`. */
  payment_method?: string;
  captured: boolean;
  error_code?: string;
  error_description?: string;
  created_at: number;
}

export interface RailRefund {
  id: string;
  entity: "refund";
  amount: number;
  currency: "USD";
  payment_id: string;
  status: "pending" | "processed" | "failed";
  notes: Record<string, string>;
  created_at: number;
}

/**
 * A split-settlement transfer: money moved from the captured payment to a
 * connected account.
 *
 * The provider settles the payment into the platform account and then
 * transfers out; the transfer is a separate entity with its own lifecycle,
 * which is why a split can be recorded, retried and audited independently of
 * the capture.
 */
export interface RailTransfer {
  id: string;
  entity: "transfer";
  source: string;
  recipient: string;
  amount: number;
  currency: "USD";
  status: "created" | "pending" | "processed" | "failed";
  notes: Record<string, string>;
  created_at: number;
}

export interface RailPaymentLink {
  id: string;
  entity: "payment_link";
  amount: number;
  currency: "USD";
  status: "created" | "paid" | "cancelled" | "expired";
  url: string;
  reference_id: string;
  notes: Record<string, string>;
  created_at: number;
}

/* ------------------------------------------------------------------- inputs */

export interface OrderInput {
  amount: Cents;
  /** Max 40 chars, unique per order. Becomes the intent's description. */
  receipt: string;
  /**
   * Max 15 pairs, 256 chars each. Mercury writes the audit trail here, so an
   * intent in the Stripe dashboard can be traced back to the exact mandate,
   * intent token, cart hash and ledger sequence that authorised it.
   */
  notes: Record<string, string>;
}

/** One leg of a split settlement. */
export interface TransferInput {
  /** Connected account id (`acct_...`). */
  account: string;
  amount: Cents;
  notes: Record<string, string>;
}

export interface PaymentLinkInput {
  amount: Cents;
  description: string;
  reference_id: string;
  notes: Record<string, string>;
  /** Unix seconds. */
  expire_by?: number;
}

/**
 * The outcome of trying to take a payment against an order.
 *
 * A decline is a *result*, not an exception: the engine retries within a bound
 * and then hands control to a human, and both of those are ordinary paths.
 */
export interface PaymentAttempt {
  payment: RailPayment;
  failed: boolean;
}

/**
 * Stripe's test payment methods. `TEST_PM_SUCCESS` authorises; `TEST_PM_DECLINED`
 * is declined with `card_declined`. The fixture honours the same two ids so a
 * scenario reads identically in either mode.
 */
export const TEST_PM_SUCCESS = "pm_card_visa";
export const TEST_PM_DECLINED = "pm_card_chargeDeclined";

/* ------------------------------------------------------------------ webhooks */

/** Mercury's normalised event names. Provider event types map onto these. */
export const WEBHOOK_EVENTS = [
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "order.paid",
  "refund.processed",
  "payment_link.paid",
  "transfer.processed",
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** A delivery after signature verification and normalisation. */
export interface WebhookEnvelope {
  entity: "event";
  /** The provider's event id (`evt_...`). Dedupe key. */
  event_id: string;
  /** The provider's own event type, kept for the audit trail. */
  provider_type: string;
  event: WebhookEventName;
  payload: {
    payment?: { entity: RailPayment };
    order?: { entity: RailOrder };
    refund?: { entity: RailRefund };
    payment_link?: { entity: RailPaymentLink };
    transfer?: { entity: RailTransfer };
  };
  created_at: number;
}

/**
 * The outcome of handing a raw webhook body to the rail.
 *
 * `REJECTED_SIGNATURE` is deliberately distinct from an error: a forged webhook
 * is an expected, handled condition, not an exception. It must never mutate
 * order state.
 */
export type WebhookVerdict =
  | { kind: "ACCEPTED"; event: WebhookEnvelope; event_id: string }
  | { kind: "DUPLICATE"; event_id: string }
  | { kind: "REJECTED_SIGNATURE"; reason: string }
  | { kind: "REJECTED_MALFORMED"; reason: string };

/* ---------------------------------------------------------------- the port */

/**
 * The one interface both rails implement. Nothing above this line knows whether
 * it is talking to a recorded fixture or to Stripe.
 */
export interface PaymentPort {
  readonly mode: "fixture" | "live";

  createOrder(input: OrderInput): Promise<RailOrder>;
  fetchOrder(orderId: string): Promise<RailOrder | undefined>;
  /**
   * Try to take the payment with the given payment method. Authorises only;
   * `capturePayment` moves the money. Never throws on a decline.
   */
  attemptPayment(orderId: string, paymentMethod: string): Promise<PaymentAttempt>;
  createPaymentLink(input: PaymentLinkInput): Promise<RailPaymentLink>;
  fetchPayment(paymentId: string): Promise<RailPayment | undefined>;
  capturePayment(paymentId: string, amount: Cents): Promise<RailPayment>;
  refund(paymentId: string, amount: Cents, notes?: Record<string, string>): Promise<RailRefund>;
  /**
   * Split a captured payment across connected accounts.
   *
   * Implementations must refuse a split that exceeds the payment: a transfer
   * of money that was never captured is not an error the rail should discover
   * asynchronously.
   */
  createTransfers(paymentId: string, transfers: readonly TransferInput[]): Promise<RailTransfer[]>;
  fetchTransfers(paymentId: string): Promise<RailTransfer[]>;

  /**
   * Verify a webhook delivery's `Stripe-Signature` header against the RAW body.
   * Returns a reason on failure rather than throwing: a forgery is expected.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string): { ok: true } | { ok: false; reason: string };
}
