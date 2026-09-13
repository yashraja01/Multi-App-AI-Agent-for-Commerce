import type { CatalogItem, MerchantProfile, Proposal, RuleId } from "@mercury/core";
import type { BasketValue, BundleSuggestion, Substitution } from "./levers.js";

/**
 * The negotiator port.
 *
 * Same shape as the rail port, and for the same reason (D10): the interesting
 * behaviour must be exercisable offline. `LlmRevenueAgent` talks to Claude;
 * `ScriptedRevenueAgent` is deterministic and needs no key, no network and no
 * spend -- and every test, plus the whole F1..F7 failure suite, runs against it.
 *
 * Both implementations use the *same* tool implementations from `tools.ts`, so
 * the scripted agent is a stand-in for the model's judgement, not a stand-in
 * for the system.
 */

/** What the gate said about an offer, flattened for the agent to read. */
export interface GateFeedback {
  outcome: "ALLOW" | "ALLOW_WITH_STEPUP" | "DENY";
  rule_ids: RuleId[];
  /** Deterministic rule messages. Never model-generated. */
  messages: string[];
  /** the gate's own total. Present when the offer was allowed. */
  computed_total_cents?: number;
  /** Notes from auto-repair, if the offer was clamped to the lowest legal price. */
  adjustments?: string[];
}

export interface NegotiationTurn {
  session_id: string;
  /** What the buyer's agent just said. */
  buyer_message: string;
  /** Prior turns, oldest first, as plain text. */
  history?: readonly { role: "buyer" | "merchant"; text: string }[];
}

export interface NegotiationRound {
  proposal: Proposal;
  feedback: GateFeedback;
}

export interface NegotiationResult {
  /** What the merchant agent said back to the buyer. */
  reply: string;
  /** Every offer made this turn, in order. More than one means the gate pushed back. */
  rounds: NegotiationRound[];
  /** The last offer that the gate accepted, if any. */
  settled?: NegotiationRound;
  /**
   * What the revenue levers were worth: the basket the buyer asked for versus
   * the basket the gate approved. The only honest measure of whether the
   * Revenue Agent earned its place, and it goes into the ledger.
   */
  value?: BasketValue;
  /** An add-on the buyer was offered but has not accepted. Never in the cart. */
  suggestion?: BundleSuggestion;
  /** Lines swapped because the requested SKU could not be filled. */
  substitutions?: Substitution[];
  /** Provenance for the ledger. Absent for the scripted agent. */
  llm?: {
    model: string;
    effort: string;
    input_hash: string;
    output_hash: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    latency_ms?: number;
  };
}

/** Everything a negotiator is allowed to see and do. */
export interface NegotiatorContext {
  profile: MerchantProfile;
  /** sku -> item, for this merchant. Carries cost_cents, which is never exposed. */
  catalog: ReadonlyMap<string, CatalogItem>;
  /** Persona markdown for this vertical. */
  persona: string;
  /**
   * Put an offer through the gate. The agent never learns anything about the
   * merchant's policy except through this return value.
   */
  submit: (proposal: Proposal) => Promise<GateFeedback>;
  /** Rounds allowed per turn, including the first. */
  maxRounds?: number;
  /**
   * Did the buyer's own message invite an add-on?
   *
   * The bundle lever is the only one that changes *what* is in the cart, so it
   * needs consent. Set per turn from the buyer's message and read by
   * `suggest_bundle`, so the model is told rather than left to judge whether it
   * was invited -- a judgement with an obvious incentive attached.
   */
  invited?: boolean;
}

export interface Negotiator {
  readonly mode: "llm" | "scripted";
  negotiate(turn: NegotiationTurn): Promise<NegotiationResult>;
}
