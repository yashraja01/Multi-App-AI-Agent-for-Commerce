import "server-only";
import {
  LlmRevenueAgent,
  ScriptedRevenueAgent,
  type Negotiator,
  type NegotiatorContext,
  gateVia,
  personaFor,
} from "@mercury/agent";
import { type Proposal, newId } from "@mercury/core";
import { TEST_PM_DECLINED, TEST_PM_SUCCESS } from "@mercury/rail";
import { mercury } from "./mercury";
import { reportUndeliverable } from "./transact";
import type { EnvelopeView, TheatreEvent } from "./types";
import type { Scenario } from "./scenarios";

/**
 * One scenario, run end to end, narrated as it happens.
 *
 * The UI is a spectator. Everything here would happen identically with the
 * browser closed -- `scripts/demo.ts` runs the same path on a terminal. What the
 * theatre adds is only the ability to watch a decision being made rather than
 * reading about it afterwards.
 */

export type { EnvelopeView, TheatreEvent };

export type Emit = (event: TheatreEvent) => void | Promise<void>;

export function envelopeView(mandateId: string): EnvelopeView | undefined {
  const m = mercury();
  const signed = m.store.getMandate(mandateId);
  const state = m.store.getMandateState(mandateId);
  if (signed === undefined || state === undefined) return undefined;
  return {
    mandate_id: mandateId,
    reserved_cents: signed.mandate.reserved_cents,
    consumed_cents: state.consumed_cents,
    remaining_cents: Math.max(0, signed.mandate.reserved_cents - state.consumed_cents),
    txn_count: state.txn_count,
    max_txn_count: signed.mandate.max_txn_count,
  };
}

function negotiator(ctx: NegotiatorContext, scenario: Scenario, mode: "scripted" | "llm"): Negotiator {
  if (mode === "llm") return new LlmRevenueAgent(ctx);
  return new ScriptedRevenueAgent(ctx, scenario.scripted);
}

export async function runScenario(
  scenario: Scenario,
  mode: "scripted" | "llm",
  emit: Emit,
  opts: {
    /**
     * The session id every ledger entry of this run carries. A caller that
     * has already written entries for the run -- the email intake logs
     * EMAIL_RECEIVED before the negotiation starts -- passes its own so the
     * audit endpoint returns the whole story under one id.
     */
    sessionId?: string;
  } = {},
): Promise<void> {
  const m = mercury();
  const profile = m.store.getMerchant(scenario.merchant_id);
  if (profile === undefined) {
    await emit({ type: "note", text: `No merchant ${scenario.merchant_id}. Try Reset.` });
    return;
  }

  const sessionId = opts.sessionId ?? newId("session");
  const catalog = m.store.catalogFor(profile.merchant_id);
  // Mission Control is the merchant's own console: the caller here is the
  // merchant, not a delegated agent, so there is no holder to prove.
  const bridge = gateVia(m.engine, {
    mandate_id: scenario.mandate_id,
    session_id: sessionId,
    requireHolderProof: false,
  });

  await emit({ type: "buyer", text: scenario.buyer });

  let round = 0;
  const ctx: NegotiatorContext = {
    profile,
    catalog,
    persona: personaFor(profile.vertical),
    maxRounds: 3,
    // Wrap the gate so the offer and the verdict can be narrated as a pair.
    submit: async (proposal: Proposal) => {
      round += 1;
      await emit({
        type: "offer",
        round,
        quoted_cents: proposal.quoted_total_cents,
        rationale: proposal.rationale,
        lines: proposal.lines.map((l) => {
          const item = catalog.get(l.sku);
          return {
            sku: l.sku,
            title: item?.title ?? l.sku,
            qty: l.qty,
            unit_cents: l.offer_unit_cents,
            list_cents: item?.list_cents ?? 0,
          };
        }),
      });

      const before = bridge.results().length;
      const feedback = await bridge.submit(proposal);
      const result = bridge.results()[before];

      await emit({
        type: "verdict",
        round,
        outcome: feedback.outcome,
        rules: result?.decision.rules ?? [],
        computed_cents: feedback.computed_total_cents,
        quoted_cents: proposal.quoted_total_cents,
        messages: feedback.messages,
      });

      if (feedback.outcome === "DENY") {
        await emit({
          type: "note",
          text: "No Stripe call was made. The denial happened before the rail was touched.",
        });
      }
      return feedback;
    },
  };

  const result = await negotiator(ctx, scenario, mode).negotiate({
    session_id: sessionId,
    buyer_message: scenario.buyer,
  });

  const accepted = bridge.accepted();

  /*
   * What the levers were worth, into the chain.
   *
   * Only when something was actually approved: an uplift on a basket the gate
   * denied is not revenue, it is a number the agent hoped for, and recording it
   * beside real ones would make the merchant console lie in the merchant's
   * favour. Goal 1 is measured, not asserted -- so it is measured on outcomes.
   */
  if (result.value !== undefined && accepted !== undefined && accepted.kind !== "DENIED") {
    m.ledger.append({
      actor: { type: "merchant_agent", id: "agt_revenue" },
      event_type: "BASKET_VALUED",
      session_id: sessionId,
      detail: {
        merchant_id: scenario.merchant_id,
        baseline_cents: result.value.baseline_cents,
        final_cents: result.value.final_cents,
        uplift_cents: result.value.uplift_cents,
        uplift_bps: result.value.uplift_bps,
        levers_used: result.value.levers_used,
      },
    });
  }

  if (accepted !== undefined && accepted.kind !== "DENIED") {
    await emit({
      type: "order",
      order_id: accepted.order_id,
      amount_cents: accepted.decision.computed_cents,
      cart: accepted.cart.lines,
    });
  }

  await emit({ type: "merchant", text: result.reply });

  if (accepted !== undefined && accepted.kind === "STEP_UP_REQUIRED") {
    await emit({
      type: "stepup",
      link_url: accepted.link_url,
      reason: accepted.decision.step_up,
    });
    await emit({
      type: "note",
      text: "Stopping here. A human, not the agent, releases this money.",
    });
  } else if (accepted !== undefined && accepted.kind === "AUTHORISED") {
    await settle(scenario, accepted.order_id, accepted.token.token_id, sessionId, emit);

    if (scenario.undeliverable === true) {
      await emit({
        type: "note",
        text: "Warehouse reports the stock is gone. The money has already moved.",
      });
      const refund = await reportUndeliverable({
        order_id: accepted.order_id,
        reason: "stock unavailable after capture",
      });
      await emit({
        type: "payment",
        status: "fallback",
        attempt: 0,
        detail:
          refund.status === "refunded"
            ? `refunded ${refund.refund_id ?? ""} — stock released and envelope restored`
            : `compensation rejected: ${refund.reason}`,
      });
      await emit({
        type: "note",
        text: "The principal is exactly where they started: money back, budget back.",
      });
    }
  }

  await emit({
    type: "done",
    envelope: envelopeView(scenario.mandate_id) ?? {
      mandate_id: scenario.mandate_id,
      reserved_cents: 0,
      consumed_cents: 0,
      remaining_cents: 0,
      txn_count: 0,
      max_txn_count: 0,
    },
    ledger_seq: m.ledger.count(),
  });
}

async function settle(
  scenario: Scenario,
  orderId: string,
  tokenId: string,
  sessionId: string,
  emit: Emit,
): Promise<void> {
  const m = mercury();
  const paymentMethod = scenario.failPayment === true ? TEST_PM_DECLINED : TEST_PM_SUCCESS;
  const outcome = await m.engine.settle({
    order_id: orderId,
    token_id: tokenId,
    session_id: sessionId,
    payment_method: paymentMethod,
    onAttempt: async ({ attempt, payment, failed }) => {
      await emit({
        type: "payment",
        status: failed ? "failed" : "captured",
        attempt,
        detail: failed
          ? `${payment.id} declined at the rail (${payment.error_code ?? paymentMethod})`
          : `${payment.id} authorised, then captured`,
      });
    },
  });

  if (outcome.kind === "CAPTURED") {
    // A B2B basket is multi-vendor: the buyer paid once and two suppliers have
    // to be paid out of it. Read the split back from the ledger rather than
    // recomputing it, so the panel shows what was actually recorded.
    const split = m.ledger
      .byEventType("SETTLEMENT_SPLIT")
      .filter((e) => e.session_id === sessionId)
      .at(-1);
    const detail = split?.detail as
      | {
          captured_cents?: number;
          commission_cents?: number;
          legs?: { account: string; amount_cents: number }[];
          failed?: boolean;
        }
      | undefined;

    if (detail !== undefined && detail.failed !== true && detail.legs !== undefined) {
      await emit({
        type: "split",
        captured_cents: detail.captured_cents ?? 0,
        commission_cents: detail.commission_cents ?? 0,
        legs: detail.legs,
      });
    }
  }

  if (outcome.kind === "FAILED_FALLBACK_LINK") {
    await emit({
      type: "payment",
      status: "fallback",
      attempt: outcome.attempts,
      detail: `retries exhausted after ${outcome.attempts}; approval link ${outcome.link_url}`,
    });
    await emit({
      type: "note",
      text: "Control handed back to a human rather than retrying indefinitely.",
    });
  } else if (outcome.kind === "REJECTED") {
    await emit({ type: "note", text: `Settlement rejected: ${outcome.reason}` });
  }

  // Replaying the same authorisation must be impossible.
  const replay = await m.engine.settle({
    order_id: orderId,
    token_id: tokenId,
    session_id: sessionId,
  });
  await emit({
    type: "note",
    text:
      replay.kind === "REJECTED"
        ? `Replay of the same intent token: rejected (${replay.reason}). No duplicate order.`
        : `Replay produced ${replay.kind} -- that should not happen.`,
  });
}

/** Consume the whole envelope, for demonstrating the residual release. */
export function closeEnvelope(mandateId: string): { released_cents: number } {
  const released = mercury().engine.closeEnvelope(mandateId, newId("session"));
  return { released_cents: released.released_cents };
}
