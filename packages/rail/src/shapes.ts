import type {
  RailOrder,
  RailPayment,
  RailPaymentLink,
  RailRefund,
  RailTransfer,
} from "./types.js";

/**
 * Stripe object shapes, narrowed to what Mercury reads, and the mapping in
 * both directions.
 *
 * `StripeRail` and the webhook parser use `*From*` to turn a Stripe object into
 * a rail entity. `FixtureRail` uses `*Of*` to emit webhook bodies in Stripe's
 * shape, so a delivery built by the fixture is indistinguishable, byte for
 * byte, from one Stripe would send -- which is what makes the forged- and
 * duplicate-webhook drills honest.
 */

/* ------------------------------------------------------------- Stripe shapes */

export interface StripePaymentIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_received: number;
  currency: string;
  status:
    | "requires_payment_method"
    | "requires_confirmation"
    | "requires_action"
    | "processing"
    | "requires_capture"
    | "canceled"
    | "succeeded";
  description?: string | null;
  latest_charge?: string | StripeCharge | null;
  metadata: Record<string, string>;
  created: number;
}

export interface StripeCharge {
  id: string;
  object: "charge";
  amount: number;
  amount_captured?: number;
  amount_refunded?: number;
  currency: string;
  status: "succeeded" | "pending" | "failed";
  captured: boolean;
  refunded?: boolean;
  payment_intent: string | null;
  payment_method?: string | null;
  payment_method_details?: { type?: string } | null;
  failure_code?: string | null;
  failure_message?: string | null;
  metadata?: Record<string, string>;
  created: number;
}

export interface StripeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  charge: string | null;
  status: "pending" | "succeeded" | "failed" | "canceled" | "requires_action" | null;
  metadata?: Record<string, string>;
  created: number;
}

export interface StripeTransfer {
  id: string;
  object: "transfer";
  amount: number;
  currency: string;
  destination: string;
  source_transaction?: string | null;
  transfer_group?: string | null;
  reversed?: boolean;
  metadata?: Record<string, string>;
  created: number;
}

export interface StripePaymentLink {
  id: string;
  object: "payment_link";
  active: boolean;
  url: string;
  metadata?: Record<string, string>;
}

/** The envelope Stripe delivers. `data.object` is one of the shapes above. */
export interface StripeEvent {
  id: string;
  object: "event";
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
  created: number;
}

/* -------------------------------------------------------- Stripe -> rail --- */

function upper(currency: string): "USD" {
  return currency.toUpperCase() as "USD";
}

export function paymentStatusOf(ch: StripeCharge): RailPayment["status"] {
  if (ch.status === "failed") return "failed";
  if (ch.refunded === true) return "refunded";
  if (ch.captured) return "captured";
  if (ch.status === "succeeded") return "authorized";
  return "created";
}

export function paymentFromCharge(ch: StripeCharge): RailPayment {
  const method = ch.payment_method_details?.type;
  return {
    id: ch.id,
    entity: "payment",
    amount: ch.amount,
    currency: upper(ch.currency),
    status: paymentStatusOf(ch),
    order_id: ch.payment_intent ?? "",
    method: method === "link" ? "link" : method === "us_bank_account" ? "bank_transfer" : "card",
    ...(ch.payment_method === undefined || ch.payment_method === null
      ? {}
      : { payment_method: ch.payment_method }),
    captured: ch.captured,
    ...(ch.failure_code === undefined || ch.failure_code === null ? {} : { error_code: ch.failure_code }),
    ...(ch.failure_message === undefined || ch.failure_message === null
      ? {}
      : { error_description: ch.failure_message }),
    created_at: ch.created,
  };
}

export function orderStatusOf(pi: StripePaymentIntent): RailOrder["status"] {
  if (pi.status === "succeeded") return "paid";
  if (pi.status === "requires_capture" || pi.status === "processing" || pi.status === "canceled") {
    return "attempted";
  }
  return "created";
}

export function orderFromIntent(pi: StripePaymentIntent, attempts = 0): RailOrder {
  const paid = pi.amount_received;
  return {
    id: pi.id,
    entity: "order",
    amount: pi.amount,
    amount_paid: paid,
    amount_due: Math.max(0, pi.amount - paid),
    currency: upper(pi.currency),
    receipt: pi.description ?? "",
    status: orderStatusOf(pi),
    attempts,
    notes: pi.metadata,
    created_at: pi.created,
  };
}

export function refundFromStripe(r: StripeRefund): RailRefund {
  const status: RailRefund["status"] =
    r.status === "succeeded" ? "processed" : r.status === "failed" || r.status === "canceled" ? "failed" : "pending";
  return {
    id: r.id,
    entity: "refund",
    amount: r.amount,
    currency: upper(r.currency),
    payment_id: r.charge ?? "",
    status,
    notes: r.metadata ?? {},
    created_at: r.created,
  };
}

export function transferFromStripe(t: StripeTransfer): RailTransfer {
  return {
    id: t.id,
    entity: "transfer",
    source: t.source_transaction ?? t.transfer_group ?? "",
    recipient: t.destination,
    amount: t.amount,
    currency: upper(t.currency),
    status: t.reversed === true ? "failed" : "processed",
    notes: t.metadata ?? {},
    created_at: t.created,
  };
}

export function linkFromStripe(l: StripePaymentLink, amount: number, referenceId: string, created: number): RailPaymentLink {
  return {
    id: l.id,
    entity: "payment_link",
    amount,
    currency: "USD",
    status: l.active ? "created" : "cancelled",
    url: l.url,
    reference_id: referenceId,
    notes: l.metadata ?? {},
    created_at: created,
  };
}

/* -------------------------------------------------------- rail -> Stripe --- */

export function chargeOf(p: RailPayment): StripeCharge {
  return {
    id: p.id,
    object: "charge",
    amount: p.amount,
    amount_captured: p.captured ? p.amount : 0,
    amount_refunded: p.status === "refunded" ? p.amount : 0,
    currency: p.currency.toLowerCase(),
    status: p.status === "failed" ? "failed" : "succeeded",
    captured: p.captured,
    refunded: p.status === "refunded",
    payment_intent: p.order_id,
    payment_method: p.payment_method ?? null,
    payment_method_details: { type: p.method === "bank_transfer" ? "us_bank_account" : p.method },
    failure_code: p.error_code ?? null,
    failure_message: p.error_description ?? null,
    created: p.created_at,
  };
}

export function intentOf(o: RailOrder): StripePaymentIntent {
  return {
    id: o.id,
    object: "payment_intent",
    amount: o.amount,
    amount_received: o.amount_paid,
    currency: o.currency.toLowerCase(),
    status: o.status === "paid" ? "succeeded" : o.status === "attempted" ? "requires_capture" : "requires_payment_method",
    description: o.receipt,
    metadata: o.notes,
    created: o.created_at,
  };
}

export function stripeRefundOf(r: RailRefund): StripeRefund {
  return {
    id: r.id,
    object: "refund",
    amount: r.amount,
    currency: r.currency.toLowerCase(),
    charge: r.payment_id,
    status: r.status === "processed" ? "succeeded" : r.status,
    metadata: r.notes,
    created: r.created_at,
  };
}

export function stripeTransferOf(t: RailTransfer): StripeTransfer {
  return {
    id: t.id,
    object: "transfer",
    amount: t.amount,
    currency: t.currency.toLowerCase(),
    destination: t.recipient,
    source_transaction: t.source,
    transfer_group: t.source,
    reversed: t.status === "failed",
    metadata: t.notes,
    created: t.created_at,
  };
}
