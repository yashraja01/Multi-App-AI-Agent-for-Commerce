import type { CartLine, RuleEval } from "@mercury/core";
export type { CartLine };

/**
 * The wire shape between the server's run loop and the browser.
 *
 * Kept out of `run.ts` because that module is `server-only` -- the client needs
 * these types to render, but must never be able to pull the engine in with them.
 */

export interface OfferLine {
  sku: string;
  title: string;
  qty: number;
  unit_cents: number;
  list_cents: number;
}

export interface EnvelopeView {
  mandate_id: string;
  reserved_cents: number;
  consumed_cents: number;
  remaining_cents: number;
  txn_count: number;
  max_txn_count: number;
}

export type Outcome = "ALLOW" | "ALLOW_WITH_STEPUP" | "DENY";

export type TheatreEvent =
  | { type: "buyer"; text: string }
  | { type: "offer"; round: number; lines: OfferLine[]; quoted_cents: number; rationale: string }
  | {
      type: "verdict";
      round: number;
      outcome: Outcome;
      rules: RuleEval[];
      computed_cents: number | undefined;
      quoted_cents: number;
      messages: string[];
    }
  | { type: "order"; order_id: string; amount_cents: number; cart: CartLine[] }
  | { type: "stepup"; link_url: string; reason: string }
  | { type: "payment"; status: "captured" | "failed" | "fallback"; detail: string; attempt: number }
  | {
      /** Split settlement: one payment, several sellers paid out of it. */
      type: "split";
      captured_cents: number;
      commission_cents: number;
      legs: { account: string; amount_cents: number }[];
    }
  | { type: "merchant"; text: string }
  | {
      /** An external-app action: gmail, slack, google_calendar. */
      type: "app";
      app: "gmail" | "slack" | "google_calendar" | "google_sheets";
      action: string;
      ok: boolean;
      detail: string;
    }
  | { type: "note"; text: string }
  | { type: "done"; envelope: EnvelopeView; ledger_seq: number };

export interface ScenarioView {
  id: string;
  label: string;
  premise: string;
  merchant_id: string;
  buyer: string;
  failure: string | null;
}

export interface StateView {
  rail_mode: "fixture" | "live";
  apps: {
    mail: "fixture" | "live";
    chat: "fixture" | "live";
    calendar: "fixture" | "live";
    sheets: "fixture" | "live";
    address: string;
  };
  business: { name: string; merchant_id: string; mandate_id: string };
  outbox: { pending: number; done: number; failed: number; held_runs: number };
  frozen: boolean;
  merchants: { merchant_id: string; display_name: string; vertical: string }[];
  envelopes: EnvelopeView[];
  ledger_count: number;
  tip: string;
  scenarios: ScenarioView[];
}

export interface LedgerEntry {
  seq: number;
  ts: string;
  event_type: string;
  actor: { type: string; id: string };
  hash: string;
  prev_hash: string;
  decision?: { outcome: string; rule_ids: string[] };
  provider?: Record<string, unknown>;
  envelope?: { reserved_cents: number; consumed_cents: number; remaining_cents: number };
  detail?: Record<string, unknown>;
}

/* ------------------------------------------------------ the merchant console */

/**
 * A merchant's policy, plus which of it no longer matches the seed.
 *
 * `modified` exists because the bench is durable: a margin floor raised for one
 * demo beat is still raised an hour later, and a chaos row failing for that
 * reason looks exactly like a regression. Naming the drift on screen is cheaper
 * than explaining it afterwards.
 */
export interface PolicyView {
  profile: MerchantProfileView;
  modified: string[];
  seeded: MerchantProfileView | null;
}

export interface MerchantProfileView {
  merchant_id: string;
  display_name: string;
  vertical: string;
  min_margin_bps: number;
  max_discount_bps: number;
  levers: string[];
  category_taxonomy: string[];
  /* The merchant's own limits on the shape of an order. Absent means no limit. */
  max_order_cents?: number;
  max_order_units?: number;
  max_order_lines?: number;
  reserve_units?: number;
  /** A subset of `category_taxonomy`. Absent means the whole taxonomy. */
  agent_categories?: string[];
  settlement?: { mode: string; commission_bps: number; commission_account_id: string };
}

export interface LeverEarning {
  lever: string;
  baskets: number;
  uplift_cents: number;
}

export interface OrderView {
  order_id: string;
  mandate_id: string;
  amount_cents: number;
  status: string;
  payment_status: string;
  created_at: string | null;
}

export interface MerchantSummary {
  merchant_id: string;
  baskets: number;
  baseline_cents: number;
  final_cents: number;
  uplift_cents: number;
  uplift_bps: number;
  levers: LeverEarning[];
  orders: OrderView[];
}

/** One frame on the run bus (`/api/events`): a theatre event with its provenance. */
export interface BusEvent {
  seq: number;
  ts: string;
  run_id: string;
  source: "email" | "button" | "mcp";
  event: TheatreEvent;
}
