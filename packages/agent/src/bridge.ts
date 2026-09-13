import type { HolderProof, RuleEval } from "@mercury/core";
import type { Engine, ProposeResult } from "./engine.js";
import type { GateFeedback } from "./negotiator.js";

/**
 * The seam between the agent and the engine.
 *
 * A negotiator only ever sees `submit: (proposal) => GateFeedback`. It does not
 * know an Engine exists, cannot reach the store, the ledger or the rail, and
 * learns nothing about merchant policy except through a verdict it was handed.
 * That is the whole containment story in one function type.
 *
 * Note what happens on ALLOW: the engine mints an intent token and creates the
 * provider order inside `submit`. So the first accepted offer is the one that
 * becomes an order, and the sink stops the agent from offering again. A denied
 * offer makes no rail call at all.
 */

export interface GateBridge {
  submit: (proposal: Parameters<Engine["propose"]>[0]["proposal"]) => Promise<GateFeedback>;
  /** The engine result for the offer that was accepted, if one was. */
  accepted(): ProposeResult | undefined;
  /** Every engine result this turn, in order. */
  results(): readonly ProposeResult[];
}

export interface GateBridgeOptions {
  mandate_id: string;
  session_id: string;
  /**
   * Let the engine clamp a below-floor offer up to the lowest legal price
   * instead of denying it. Off by default here: during a negotiation we want
   * the *agent* to see the denial and re-quote, which is the behaviour F1
   * exercises. The engine's own auto-repair is the backstop for a single-shot
   * caller that has no agent in the loop.
   */
  autoRepair?: boolean;
  llm?: { model: string; effort: string; input_hash: string; output_hash: string };
  /** Demand proof the caller holds the mandate. True on every buyer-facing path. */
  requireHolderProof?: boolean;
  holder_proof?: HolderProof;
}

function messageOf(rule: RuleEval): string {
  return `${rule.rule_id}: ${rule.message} (observed ${rule.observed}, limit ${rule.limit})`;
}

export function gateVia(engine: Engine, opts: GateBridgeOptions): GateBridge {
  const results: ProposeResult[] = [];
  let accepted: ProposeResult | undefined;

  return {
    results: () => results,
    accepted: () => accepted,
    submit: async (proposal) => {
      const result = await engine.propose({
        mandate_id: opts.mandate_id,
        session_id: opts.session_id,
        proposal,
        autoRepair: opts.autoRepair ?? false,
        requireHolderProof: opts.requireHolderProof ?? false,
        ...(opts.holder_proof === undefined ? {} : { holder_proof: opts.holder_proof }),
        ...(opts.llm === undefined ? {} : { llm: opts.llm }),
      });
      results.push(result);

      if (result.kind === "DENIED") {
        // A denial carries no priced cart, but a drift denial still knows what
        // The gate computed: the drift rule tests the agent's figure (observed)
        // against the gate's own (limit). Surfacing it means the one case that
        // exists to show the two numbers side by side can actually show them.
        const drift = result.decision.rules.find(
          (r) => r.rule_id === "DRIFT.AMOUNT_MISMATCH" && !r.passed,
        );
        return {
          outcome: "DENY",
          rule_ids: [result.rule_id],
          messages: [messageOf(result.decision.violation)],
          ...(drift === undefined ? {} : { computed_total_cents: drift.limit }),
        };
      }

      accepted = result;
      const failed = result.decision.rules.filter((r) => !r.passed).map(messageOf);
      return {
        outcome: result.kind === "AUTHORISED" ? "ALLOW" : "ALLOW_WITH_STEPUP",
        rule_ids: result.decision.rules.map((r) => r.rule_id),
        messages:
          result.kind === "AUTHORISED"
            ? failed
            : [...failed, `step-up required: ${result.decision.step_up}`],
        computed_total_cents: result.decision.computed_cents,
        ...(result.adjustments.length === 0 ? {} : { adjustments: result.adjustments }),
      };
    },
  };
}
