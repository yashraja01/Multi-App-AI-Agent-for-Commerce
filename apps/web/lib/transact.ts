import "server-only";
import {
  LlmRevenueAgent,
  ScriptedRevenueAgent,
  type NegotiatorContext,
  gateVia,
  personaFor,
} from "@mercury/agent";
import {
  type HolderProof,
  type Proposal,
  type RuleEval,
  holderChallenge,
  newId,
  verifyValue,
} from "@mercury/core";
import { TEST_PM_DECLINED, TEST_PM_SUCCESS } from "@mercury/rail";
import { mercury } from "./mercury";
import { envelopeView } from "./run";
import type { EnvelopeView } from "./types";

/**
 * The buyer-facing transaction path.
 *
 * This is what an external agent reaches through MCP. Note what it does *not*
 * accept: a price, a total, a discount, or a cart the buyer priced itself. A
 * buyer sends a sentence and a mandate id. The merchant's own agent proposes,
 * the gate disposes, and the buyer is told what happened.
 *
 * That asymmetry is the point. An outside model driving this API cannot name
 * an amount, so no amount it hallucinates can ever be charged.
 */

export interface QuoteLine {
  sku: string;
  title: string;
  qty: number;
  unit_cents: number;
  list_cents: number;
  line_total_cents: number;
}

export interface QuoteResult {
  session_id: string;
  outcome: "ALLOW" | "ALLOW_WITH_STEPUP" | "DENY";
  merchant: { merchant_id: string; display_name: string; vertical: string };
  reply: string;
  /** Present when the gate allowed the cart. */
  cart?: {
    lines: QuoteLine[];
    total_cents: number;
    order_id: string;
    intent_token_id: string;
    expires_at: string;
  };
  /** Present when a human must approve before the money moves. */
  step_up?: { reason: string; approval_url: string };
  /** Every rule the gate evaluated, with the observed value and the limit. */
  rules: RuleEval[];
  /** Rounds the merchant agent needed. More than one means the gate pushed back. */
  rounds: number;
  envelope: EnvelopeView | undefined;
  /** Where in the ledger this negotiation is recorded. */
  ledger_seq: number;
}

export class TransactError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "TransactError";
    this.status = status;
  }
}

export async function quote(input: {
  merchant_id: string;
  mandate_id: string;
  message: string;
  mode?: "scripted" | "llm";
  /**
   * Proof the caller holds this mandate. Required unless `internal` is set,
   * which only Mission Control does -- there the caller *is* the merchant.
   */
  holder_proof?: HolderProof;
  internal?: boolean;
}): Promise<QuoteResult> {
  const m = mercury();

  const profile = m.store.getMerchant(input.merchant_id);
  if (profile === undefined) {
    throw new TransactError(`no such merchant: ${input.merchant_id}`, 404);
  }
  if (m.store.getMandate(input.mandate_id) === undefined) {
    throw new TransactError(`no such mandate: ${input.mandate_id}`, 404);
  }

  const sessionId = newId("session");
  const catalog = m.store.catalogFor(profile.merchant_id);
  const bridge = gateVia(m.engine, {
    mandate_id: input.mandate_id,
    session_id: sessionId,
    requireHolderProof: input.internal !== true,
    ...(input.holder_proof === undefined ? {} : { holder_proof: input.holder_proof }),
  });

  let lastRules: RuleEval[] = [];
  const ctx: NegotiatorContext = {
    profile,
    catalog,
    persona: personaFor(profile.vertical),
    maxRounds: 3,
    submit: async (proposal: Proposal) => {
      const before = bridge.results().length;
      const feedback = await bridge.submit(proposal);
      lastRules = bridge.results()[before]?.decision.rules ?? [];
      return feedback;
    },
  };

  const agent =
    input.mode === "llm"
      ? new LlmRevenueAgent(ctx)
      : new ScriptedRevenueAgent(ctx, {});

  const result = await agent.negotiate({
    session_id: sessionId,
    buyer_message: input.message,
  });

  const accepted = bridge.accepted();

  /*
   * What the levers were worth, into the chain -- on this path too.
   *
   * Mission Control recorded this from the start and the buyer-facing API did
   * not, which meant a purchase made from Claude Desktop over MCP earned the
   * merchant real money and contributed nothing to the revenue the console
   * reports. The console sums `BASKET_VALUED` out of the ledger, so an uplift
   * that is never appended is an uplift that never happened as far as any
   * auditor is concerned -- and Goal 1 is the claim that most needs to survive
   * being checked.
   *
   * Same condition as Mission Control: only a basket the gate approved counts.
   */
  if (result.value !== undefined && accepted !== undefined && accepted.kind !== "DENIED") {
    m.ledger.append({
      actor: { type: "merchant_agent", id: "agt_revenue" },
      event_type: "BASKET_VALUED",
      session_id: sessionId,
      detail: {
        merchant_id: profile.merchant_id,
        baseline_cents: result.value.baseline_cents,
        final_cents: result.value.final_cents,
        uplift_cents: result.value.uplift_cents,
        uplift_bps: result.value.uplift_bps,
        levers_used: result.value.levers_used,
      },
    });
  }

  const base = {
    session_id: sessionId,
    merchant: {
      merchant_id: profile.merchant_id,
      display_name: profile.display_name,
      vertical: profile.vertical,
    },
    reply: result.reply,
    rules: lastRules,
    rounds: result.rounds.length,
    envelope: envelopeView(input.mandate_id),
    ledger_seq: m.ledger.count(),
  };

  if (accepted === undefined || accepted.kind === "DENIED") {
    return { ...base, outcome: "DENY" };
  }

  const cart = {
    lines: accepted.cart.lines.map((l) => ({
      sku: l.sku,
      title: catalog.get(l.sku)?.title ?? l.sku,
      qty: l.qty,
      unit_cents: l.unit_cents,
      list_cents: l.list_cents,
      line_total_cents: l.line_total_cents,
    })),
    total_cents: accepted.decision.computed_cents,
    order_id: accepted.order_id,
    intent_token_id: accepted.token.token_id,
    expires_at: accepted.token.expires_at,
  };

  if (accepted.kind === "STEP_UP_REQUIRED") {
    return {
      ...base,
      outcome: "ALLOW_WITH_STEPUP",
      cart,
      step_up: { reason: accepted.decision.step_up, approval_url: accepted.link_url },
    };
  }

  return { ...base, outcome: "ALLOW", cart };
}

export interface PayResult {
  status: "captured" | "approval_required" | "rejected";
  payment_id?: string;
  amount_cents?: number;
  attempts?: number;
  approval_url?: string;
  reason?: string;
  envelope: EnvelopeView | undefined;
  ledger_seq: number;
}

/**
 * Redeem an intent token.
 *
 * The token is spent before the payment is attempted, so a replay is rejected
 * even if it arrives while the first attempt is still in flight.
 */
export async function pay(input: {
  order_id: string;
  intent_token_id: string;
  /** Proof the caller holds the mandate this order draws down. */
  holder_proof?: HolderProof;
  internal?: boolean;
  /**
   * The session the quote ran under. Threading it through means the whole
   * transaction -- offer, decision, order, capture -- lands in the ledger under
   * one id, so a buyer can read back its own purchase in a single query. A new
   * id would still be recorded, just orphaned from the negotiation that caused it.
   */
  session_id?: string;
  /** Fixture only: use the failing test VPA to exercise the decline path. */
  simulate_failure?: boolean;
}): Promise<PayResult> {
  const m = mercury();
  const order = m.store.getOrder(input.order_id);
  if (order === undefined) throw new TransactError(`no such order: ${input.order_id}`, 404);

  // Redeeming a token moves money, so it needs the same proof as quoting did.
  if (input.internal !== true) {
    const check = verifyHolder(order.mandate_id, input.holder_proof);
    if (!check.ok) throw new TransactError(check.reason, 401);
  }

  const sessionId = input.session_id ?? newId("session");

  const outcome = await m.engine.settle({
    order_id: input.order_id,
    token_id: input.intent_token_id,
    session_id: sessionId,
    // A demo affordance, fixture-only: a buyer may decline its *own* payment to
    // exercise the retry path. Holder proof binds it to its own order, and in
    // live mode the flag is ignored -- no API chooses a real payment method.
    payment_method:
      m.fixture !== undefined && input.simulate_failure === true ? TEST_PM_DECLINED : TEST_PM_SUCCESS,
  });

  const tail = { envelope: envelopeView(order.mandate_id), ledger_seq: m.ledger.count() };

  switch (outcome.kind) {
    case "CAPTURED":
      return {
        status: "captured",
        payment_id: outcome.payment_id,
        amount_cents: outcome.amount,
        ...tail,
      };
    case "FAILED_FALLBACK_LINK":
      return {
        status: "approval_required",
        attempts: outcome.attempts,
        approval_url: outcome.link_url,
        reason: "automated retries exhausted; a human must approve this payment",
        ...tail,
      };
    case "REFUNDED":
      return { status: "rejected", reason: `refunded: ${outcome.reason}`, ...tail };
    default:
      return { status: "rejected", reason: outcome.reason, ...tail };
  }
}

/**
 * Verify a holder proof outside the gate, for paths that do not run the gate.
 *
 * Quoting goes through `evaluate()` and gets `HOLDER.*` rules in its decision.
 * Paying does not re-run the gate -- the intent token already carries the
 * authorisation -- so the same check has to happen here, against the same key
 * from inside the same signed mandate.
 */
export function verifyHolder(
  mandateId: string,
  proof: HolderProof | undefined,
  skewMs = 120_000,
): { ok: true } | { ok: false; reason: string } {
  const m = mercury();
  const signed = m.store.getMandate(mandateId);
  if (signed === undefined) return { ok: false, reason: `no such mandate: ${mandateId}` };
  if (proof === undefined) return { ok: false, reason: "HOLDER.PROOF_MISSING" };
  if (proof.mandate_id !== mandateId) {
    return { ok: false, reason: `HOLDER.SIGNATURE: proof is for ${proof.mandate_id}` };
  }

  const issued = Date.parse(proof.issued_at);
  if (Number.isNaN(issued) || Math.abs(Date.now() - issued) > skewMs) {
    return { ok: false, reason: "HOLDER.STALE" };
  }
  if (!m.store.useHolderNonce(proof.nonce)) {
    return { ok: false, reason: "HOLDER.NONCE_REPLAY" };
  }
  if (!verifyValue(holderChallenge(proof), proof.signature, signed.mandate.agent_public_key)) {
    return { ok: false, reason: "HOLDER.SIGNATURE" };
  }
  return { ok: true };
}

/* ------------------------------------------------------------ compensation */

export interface CompensationResult {
  status: "refunded" | "rejected";
  refund_id?: string;
  amount_cents?: number;
  reason: string;
  envelope: EnvelopeView | undefined;
  ledger_seq: number;
}

/**
 * F3's second half: money took, goods cannot ship.
 *
 * Stock is reserved before the order is created, so the ordinary inventory race
 * is settled at reservation time and the loser never pays. This is the harder
 * case -- the warehouse discovers after capture that the unit is gone -- and it
 * is a merchant-side report, not something a buyer can claim.
 *
 * The recovery has to leave the principal exactly where they started: refund
 * the payment, put the stock back, and restore the envelope. Refunding without
 * restoring the envelope would silently burn the buyer's budget for goods they
 * never received, which is a quieter failure than not refunding at all.
 */
export async function reportUndeliverable(input: {
  order_id: string;
  reason: string;
}): Promise<CompensationResult> {
  const m = mercury();
  const order = m.store.getOrder(input.order_id);
  if (order === undefined) throw new TransactError(`no such order: ${input.order_id}`, 404);

  if (order.payment_id === null || order.status !== "paid") {
    throw new TransactError(
      `order ${input.order_id} is ${order.status}; there is nothing captured to refund`,
      409,
    );
  }

  // Put back exactly what this order took out.
  const cart = m.store.getOrder(input.order_id);
  const lines = cartLinesOf(cart?.cart_hash ?? "");

  const outcome = await m.engine.compensate({
    order_id: input.order_id,
    payment_id: order.payment_id,
    session_id: newId("session"),
    reason: input.reason,
    restore: lines,
  });

  const tail = { envelope: envelopeView(order.mandate_id), ledger_seq: m.ledger.count() };
  if (outcome.kind === "REFUNDED") {
    return {
      status: "refunded",
      refund_id: outcome.refund_id,
      amount_cents: order.amount,
      reason: input.reason,
      ...tail,
    };
  }
  return {
    status: "rejected",
    reason: outcome.kind === "REJECTED" ? outcome.reason : `unexpected outcome ${outcome.kind}`,
    ...tail,
  };
}

/**
 * The lines an order reserved, recovered from the ledger.
 *
 * The orders table stores a cart hash rather than the cart, so the authoritative
 * record of what was reserved is the ORDER_CREATED entry the ledger already holds --
 * which is the ledger being useful for something other than proof.
 */
function cartLinesOf(cartHash: string): { sku: string; qty: number }[] {
  if (cartHash === "") return [];
  const entry = mercury()
    .ledger.byEventType("ORDER_CREATED")
    .find((e) => e.cart_mandate_hash === cartHash);
  const lines = (entry?.detail as { lines?: { sku: string; qty: number }[] } | undefined)?.lines;
  return lines ?? [];
}
