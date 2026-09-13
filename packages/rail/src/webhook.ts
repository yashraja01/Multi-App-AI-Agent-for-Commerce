import {
  type StripeCharge,
  type StripeEvent,
  type StripePaymentIntent,
  type StripeRefund,
  type StripeTransfer,
  orderFromIntent,
  paymentFromCharge,
  refundFromStripe,
  transferFromStripe,
} from "./shapes.js";
import type { PaymentPort, PaymentStatus, WebhookEnvelope, WebhookEventName, WebhookVerdict } from "./types.js";

/**
 * The webhook gate.
 *
 * Three properties this must have, and the reasons they matter:
 *
 *  1. Verify the signature against the RAW body, before parsing. A forged
 *     delivery is rejected without touching any state (F4).
 *  2. Deduplicate on the event id. Stripe retries until it gets a 2xx, so the
 *     same event will arrive more than once (F5).
 *  3. Tolerate out-of-order delivery. Stripe explicitly does not guarantee
 *     ordering, so payment state advances monotonically: a late `authorized`
 *     after a `captured` is ignored rather than regressing the payment (F5).
 */

/** Where processed event ids are remembered. Backed by SQLite in the app. */
export interface SeenEventStore {
  has(eventId: string): boolean;
  add(eventId: string): void;
}

export class InMemorySeenEvents implements SeenEventStore {
  readonly #ids = new Set<string>();
  has(eventId: string): boolean {
    return this.#ids.has(eventId);
  }
  add(eventId: string): void {
    this.#ids.add(eventId);
  }
}

export interface WebhookHeaders {
  "stripe-signature"?: string;
}

export class WebhookGate {
  readonly #rail: PaymentPort;
  readonly #seen: SeenEventStore;

  constructor(rail: PaymentPort, seen: SeenEventStore = new InMemorySeenEvents()) {
    this.#rail = rail;
    this.#seen = seen;
  }

  /**
   * Process one delivery.
   *
   * Takes the raw body as a string on purpose: parsing and re-serialising JSON
   * changes the bytes and would break signature verification every time.
   */
  handle(rawBody: string, headers: WebhookHeaders): WebhookVerdict {
    const signature = headers["stripe-signature"];
    if (signature === undefined || signature === "") {
      return { kind: "REJECTED_SIGNATURE", reason: "missing Stripe-Signature header" };
    }

    // Signature first. Nothing below this line runs for a forged delivery.
    const verified = this.#rail.verifyWebhookSignature(rawBody, signature);
    if (!verified.ok) {
      return { kind: "REJECTED_SIGNATURE", reason: verified.reason };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (e) {
      return {
        kind: "REJECTED_MALFORMED",
        reason: `body is not JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (!isStripeEvent(parsed)) {
      return { kind: "REJECTED_MALFORMED", reason: "body is not a Stripe event" };
    }

    const envelope = normalise(parsed);
    if (envelope === undefined) {
      return { kind: "REJECTED_MALFORMED", reason: `unhandled Stripe event type: ${parsed.type}` };
    }

    if (this.#seen.has(parsed.id)) {
      return { kind: "DUPLICATE", event_id: parsed.id };
    }

    this.#seen.add(parsed.id);
    return { kind: "ACCEPTED", event: envelope, event_id: parsed.id };
  }
}

function isStripeEvent(v: unknown): v is StripeEvent {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const data = o["data"];
  return (
    o["object"] === "event" &&
    typeof o["id"] === "string" &&
    o["id"] !== "" &&
    typeof o["type"] === "string" &&
    typeof data === "object" &&
    data !== null &&
    typeof (data as Record<string, unknown>)["object"] === "object" &&
    (data as Record<string, unknown>)["object"] !== null
  );
}

/* ------------------------------------------------------------ normalisation */

/**
 * Stripe's event types, mapped onto Mercury's.
 *
 * Charges carry the payment lifecycle: with manual capture, `charge.succeeded`
 * fires on authorisation (captured: false) and `charge.captured` when the
 * money moves. The one place the mapping needs to look inside the object is
 * that first event, because Stripe uses the same type for an auto-captured
 * charge.
 */
export const STRIPE_EVENT_MAP: Record<string, WebhookEventName> = {
  "charge.succeeded": "payment.authorized",
  "charge.captured": "payment.captured",
  "charge.failed": "payment.failed",
  "charge.refunded": "refund.processed",
  "payment_intent.succeeded": "order.paid",
  "checkout.session.completed": "payment_link.paid",
  "transfer.created": "transfer.processed",
};

export function normalise(ev: StripeEvent): WebhookEnvelope | undefined {
  const mapped = STRIPE_EVENT_MAP[ev.type];
  if (mapped === undefined) return undefined;

  const obj = ev.data.object;
  let event: WebhookEventName = mapped;
  const payload: WebhookEnvelope["payload"] = {};

  switch (obj["object"]) {
    case "charge": {
      const ch = obj as unknown as StripeCharge;
      const payment = paymentFromCharge(ch);
      payload.payment = { entity: payment };
      if (ev.type === "charge.succeeded" && ch.captured) event = "payment.captured";
      if (ev.type === "charge.refunded") {
        payload.refund = {
          entity: {
            id: `${ch.id}_refund`,
            entity: "refund",
            amount: ch.amount_refunded ?? ch.amount,
            currency: payment.currency,
            payment_id: ch.id,
            status: "processed",
            notes: {},
            created_at: ev.created,
          },
        };
      }
      break;
    }
    case "payment_intent":
      payload.order = { entity: orderFromIntent(obj as unknown as StripePaymentIntent) };
      break;
    case "refund":
      payload.refund = { entity: refundFromStripe(obj as unknown as StripeRefund) };
      break;
    case "transfer":
      payload.transfer = { entity: transferFromStripe(obj as unknown as StripeTransfer) };
      break;
    default:
      break;
  }

  return {
    entity: "event",
    event_id: ev.id,
    provider_type: ev.type,
    event,
    payload,
    created_at: ev.created,
  };
}

/* ------------------------------------------------- monotonic payment state */

/**
 * Rank of each payment status. State may only move up.
 *
 * `failed` and `authorized` share a rank because they are alternative outcomes
 * of the same step; a payment never moves between them.
 */
const RANK: Record<PaymentStatus, number> = {
  created: 0,
  failed: 1,
  authorized: 1,
  captured: 2,
  refunded: 3,
};

export function statusRank(s: PaymentStatus): number {
  return RANK[s];
}

/**
 * Fold a newly observed status into the status we already hold.
 *
 * Returns the status to persist. Because this only ever advances, a `captured`
 * that arrives before its `authorized` still converges to `captured`, and the
 * late `authorized` is a no-op instead of a regression.
 */
export function advanceStatus(current: PaymentStatus, observed: PaymentStatus): PaymentStatus {
  return RANK[observed] > RANK[current] ? observed : current;
}
