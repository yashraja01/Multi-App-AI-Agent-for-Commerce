import type { DecisionOutcome, RuleEval, RuleId } from "@mercury/core";

/**
 * Ledger event types.
 *
 * Naming convention: PAST_TENSE_OUTCOME. Every name reads as a completed fact,
 * so the ledger is legible without a legend.
 */
export const EVENT_TYPES = [
  "MANDATE_ISSUED",
  "OFFER_PROPOSED",
  "GATE_DECISION",
  "DRIFT_BLOCKED",
  "REPRICED",
  "ORDER_CREATED",
  "PAYMENT_CAPTURED",
  "SETTLEMENT_SPLIT",
  "PAYMENT_FAILED",
  "RETRY_BOUNDED",
  "STEPUP_ISSUED",
  "STEPUP_APPROVED",
  "INVENTORY_CONFLICT",
  "AUTO_REFUND_ISSUED",
  "WEBHOOK_ACCEPTED",
  "WEBHOOK_REJECTED",
  "WEBHOOK_DEDUPED",
  "MANDATE_BREACH_BLOCKED",
  "REPLAY_BLOCKED",
  "ENVELOPE_RESIDUAL_RELEASED",
  "CIRCUIT_FROZEN",
  "CIRCUIT_UNFROZEN",
  /**
   * What the revenue levers were worth on one negotiation: the basket the buyer
   * asked for at ordinary pricing, against what the gate actually approved.
   *
   * It sits in the chain rather than in a metrics table because a merchant's
   * claim to have grown a basket should be as checkable as its claim not to
   * have overcharged. An uplift figure nobody can audit is marketing.
   */
  "BASKET_VALUED",
  /**
   * A merchant changed its own policy: margin floor, discount ceiling, which
   * levers are permitted, or the Route commission.
   *
   * A merchant loosening its own margin floor is exactly the kind of thing an
   * audit trail exists to record. Without this, a cart approved at 8% margin
   * under a 15% floor would look like a gate failure rather than a policy
   * change made a minute earlier.
   */
  "POLICY_CHANGED",
  /*
   * The external apps. Every action the agent takes in another system is a
   * line here, so the chain covers the whole run -- not only the cents. An
   * agent that provably paid the right amount but cannot show what it told
   * the owner afterwards has half an audit trail.
   */
  /** A request arrived in the agent's inbox and was taken up. */
  "EMAIL_RECEIVED",
  /** A receipt, approval request or refusal left the agent's outbox. */
  "EMAIL_SENT",
  /** A message was posted to the team's chat channel. */
  "CHAT_POSTED",
  /** A delivery or follow-up was put on the business's calendar. */
  "CALENDAR_EVENT_CREATED",
  /** A paid order was appended to the business's purchase log. */
  "SHEET_ROW_APPENDED",
  /**
   * An external-app action failed after its bounded retries. Recorded, never
   * swallowed; and never allowed to touch the payment it followed.
   */
  "APP_ACTION_FAILED",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type ActorType =
  | "human"
  | "buyer_agent"
  | "merchant_agent"
  | "gate"
  | "rail"
  /** An external application: gmail, slack, google_calendar. */
  | "app"
  | "system";

export interface Actor {
  type: ActorType;
  id: string;
}

export interface EnvelopeState {
  reserved_cents: number;
  consumed_cents: number;
  remaining_cents: number;
}

export interface DecisionRecord {
  outcome: DecisionOutcome;
  rule_ids: RuleId[];
  evidence: RuleEval[];
}

export interface ProviderRecord {
  order_id?: string;
  payment_id?: string;
  refund_id?: string;
  transfer_ids?: string[];
  link_id?: string;
  event_id?: string;
  signature_verified?: boolean;
}

/**
 * LLM provenance. Hashes rather than raw text, so the ledger records exactly
 * which prompt produced which output without storing prompt bodies.
 */
export interface LlmRecord {
  model: string;
  effort: string;
  input_hash: string;
  output_hash: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
}

/** The body of a ledger entry: everything the hash covers except the chain links. */
export interface EntryBody {
  seq: number;
  ts: string;
  actor: Actor;
  event_type: EventType;
  session_id?: string;
  delegation_scope?: { mandate_id: string; scope_hash: string };
  intent_token_id?: string;
  cart_mandate_hash?: string;
  envelope?: EnvelopeState;
  decision?: DecisionRecord;
  provider?: ProviderRecord;
  llm?: LlmRecord;
  /** Free-form structured detail. Must be canonical-JSON serialisable. */
  detail?: Record<string, unknown>;
}

/** A persisted entry: the body plus its chain links. */
export interface LedgerEntry extends EntryBody {
  prev_hash: string;
  hash: string;
}

/** What a caller supplies to `append`. `seq` and `ts` are assigned by the ledger. */
export type EntryInput = Omit<EntryBody, "seq" | "ts"> & { ts?: string };

export type VerifyResult =
  | { ok: true; count: number }
  | {
      ok: false;
      count: number;
      /** Sequence number of the first entry that failed. */
      broken_at: number;
      reason:
        | "HASH_MISMATCH"
        | "PREV_HASH_MISMATCH"
        | "SEQ_GAP"
        | "COLUMN_TAMPERED"
        | "BODY_UNPARSEABLE";
      detail: string;
    };
