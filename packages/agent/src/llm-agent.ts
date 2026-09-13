import Anthropic from "@anthropic-ai/sdk";
import type { Lever, Proposal } from "@mercury/core";
import { cents, sha256Hex } from "@mercury/core";
import type {
  GateFeedback,
  Negotiator,
  NegotiationResult,
  NegotiationRound,
  NegotiationTurn,
  NegotiatorContext,
} from "./negotiator.js";
import { promptHash, systemPrompt } from "./prompts.js";
import {
  type LeverSink,
  type OfferSink,
  type TierQuote,
  buyerTools,
  revenueTools,
} from "./tools.js";
import { inferCart, invitesAddOns, ordinaryBasket } from "./basket.js";
import {
  type BundleSuggestion,
  type Substitution,
  basketValue,
} from "./levers.js";

/**
 * The Revenue Agent, backed by Claude.
 *
 * What this class is careful about:
 *
 *   - It never computes a final price. It calls `submit_offer`, which calls
 *     Gate, which recomputes the total from the catalogue. The model's
 *     arithmetic is checked and then discarded.
 *   - The cached prefix is `tools -> system`, and both are frozen for the life
 *     of a merchant. Volatile turn state goes in a mid-conversation `system`
 *     message *after* the breakpoint, so injecting a gate verdict or an
 *     envelope balance costs nothing in cache terms.
 *   - Adaptive thinking with a configurable effort. Negotiation under hard
 *     constraints is exactly the kind of work that benefits from it.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmOptions {
  /** Injectable so tests can pass a fake with the same surface. */
  client?: Anthropic;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Bound on API round-trips per turn. Each offer costs one. */
  maxIterations?: number;
}

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_EFFORT: Effort = "high";

export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): Anthropic {
  // A bare constructor also resolves an `ant auth login` profile, so an unset
  // ANTHROPIC_API_KEY is not by itself a missing credential.
  const key = env["ANTHROPIC_API_KEY"];
  return key === undefined || key === "" ? new Anthropic() : new Anthropic({ apiKey: key });
}

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const m = env["MERCURY_MODEL"];
  return m === undefined || m === "" ? DEFAULT_MODEL : m;
}

export function effortFromEnv(env: NodeJS.ProcessEnv = process.env): Effort {
  const e = env["MERCURY_EFFORT"];
  const allowed: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  return allowed.includes(e as Effort) ? (e as Effort) : DEFAULT_EFFORT;
}

/** Accumulates the offers made during one turn and knows when to stop. */
class Sink implements OfferSink {
  readonly list: NegotiationRound[] = [];
  #settled: NegotiationRound | undefined;

  record(proposal: Proposal, feedback: GateFeedback): void {
    const round: NegotiationRound = { proposal, feedback };
    this.list.push(round);
    if (feedback.outcome !== "DENY") this.#settled = round;
  }

  settled(): boolean {
    return this.#settled !== undefined;
  }

  rounds(): number {
    return this.list.length;
  }

  get accepted(): NegotiationRound | undefined {
    return this.#settled;
  }
}

/**
 * What the model pulled, and what it was worth.
 *
 * The scripted agent applies levers itself, so it knows what it used. The model
 * chooses, so attribution has to be *earned*: every lever tool records what it
 * offered here, and afterwards each record is checked against the cart that
 * actually settled. A lever the model looked at and ignored is not revenue.
 *
 * The check is deliberately conservative -- the bulk-tier unit price must be
 * the price on the line, not merely near it. Under-counting an uplift is a
 * survivable error in a merchant console; over-counting one is a lie about
 * money, and the whole point of Goal 1 being *measured* is that it cannot be.
 */
class LeverLog implements LeverSink {
  readonly #tiers: TierQuote[] = [];
  readonly #bundles: BundleSuggestion[] = [];
  readonly #subs: Substitution[] = [];

  tier(q: TierQuote): void {
    this.#tiers.push(q);
  }

  bundle(s: BundleSuggestion): void {
    this.#bundles.push(s);
  }

  substitute(s: Substitution): void {
    this.#subs.push(s);
  }

  /**
   * Which levers are visible in the settled cart.
   *
   * `asked` is the basket the buyer's own message named, which is how a bundle
   * is told apart from a line the buyer requested directly.
   */
  attribute(
    settled: Proposal | undefined,
    asked: readonly { sku: string; qty: number }[],
  ): {
    used: Lever[];
    substitutions: Substitution[];
    suggestion?: BundleSuggestion;
  } {
    const lines = settled?.lines ?? [];
    const inCart = new Map(lines.map((l) => [l.sku, l]));
    const askedFor = new Set(asked.map((a) => a.sku));
    const used: Lever[] = [];

    // -- bulk tier: the tier price is the price on the line ------------------
    const tiered = this.#tiers.some((q) => {
      if (q.discount_bps <= 0) return false;
      const line = inCart.get(q.sku);
      return line !== undefined && line.offer_unit_cents === q.unit_cents;
    });
    if (tiered) used.push("bulk_tier");

    // -- bundle: the add-on is in the cart and the buyer did not ask for it --
    const landed = this.#bundles.find((b) => inCart.has(b.sku) && !askedFor.has(b.sku));
    if (landed !== undefined) used.push("bundle");

    // -- substitute: the replacement is in, the original is out --------------
    const substitutions = this.#subs.filter(
      (s) => inCart.has(s.to_sku) && !inCart.has(s.from_sku),
    );
    if (substitutions.length > 0) used.push("substitute");

    // An add-on that was offered and did not enter the cart is a suggestion,
    // which is the outcome the consent rule is supposed to produce.
    const offered = this.#bundles.find((b) => !inCart.has(b.sku));

    return {
      used,
      substitutions,
      ...(landed === undefined && offered !== undefined ? { suggestion: offered } : {}),
    };
  }
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export class LlmRevenueAgent implements Negotiator {
  readonly mode = "llm" as const;
  readonly #ctx: NegotiatorContext;
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #effort: Effort;
  readonly #maxTokens: number;
  readonly #maxIterations: number;

  constructor(ctx: NegotiatorContext, opts: LlmOptions = {}) {
    this.#ctx = ctx;
    this.#client = opts.client ?? clientFromEnv();
    this.#model = opts.model ?? modelFromEnv();
    this.#effort = opts.effort ?? effortFromEnv();
    this.#maxTokens = opts.maxTokens ?? 8_000;
    // Each offer is one round-trip; leave room for catalogue lookups and a close.
    this.#maxIterations = opts.maxIterations ?? (this.#ctx.maxRounds ?? 3) * 2 + 4;
  }

  async negotiate(turn: NegotiationTurn): Promise<NegotiationResult> {
    const sink = new Sink();
    const levers = new LeverLog();

    /*
     * The buyer's consent, decided once and handed to the tool.
     *
     * `invitesAddOns` is the same test the scripted agent applies. Putting the
     * answer in the context rather than in the prompt means the model is told
     * whether it was invited instead of ruling on it -- a question it has an
     * obvious incentive to get wrong.
     */
    const ctx: NegotiatorContext = {
      ...this.#ctx,
      invited: invitesAddOns(turn.buyer_message),
    };

    // What the buyer's message named, priced with no lever pulled. The model
    // does not see this: it is the counterfactual the uplift is measured
    // against, and an agent that could see its own scorecard would optimise it.
    const asked = inferCart(ctx, turn.buyer_message);
    const baseline = ordinaryBasket(ctx, asked);

    const tools = revenueTools(ctx, sink, levers);
    const system = systemPrompt(this.#ctx.persona);

    const history: Anthropic.Beta.BetaMessageParam[] = (turn.history ?? []).map((h) => ({
      role: h.role === "buyer" ? "user" : "assistant",
      content: h.text,
    }));

    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...history,
      { role: "user", content: turn.buyer_message },
      // Volatile operator state. Deliberately a mid-conversation system message
      // rather than an edit to the top-level system prompt: it carries operator
      // authority, is not confusable with buyer text, and leaves the cached
      // prefix byte-identical.
      {
        role: "system",
        content:
          `Session ${turn.session_id}. Merchant ${this.#ctx.profile.merchant_id} ` +
          `(${this.#ctx.profile.display_name}), vertical ${this.#ctx.profile.vertical}. ` +
          `You may submit at most ${this.#ctx.maxRounds ?? 3} offers this turn. ` +
          `End your turn with a short message to the buyer, not with a tool call. ` +
          `Revenue levers permitted for this merchant: ` +
          `${ctx.profile.levers.length === 0 ? "none" : ctx.profile.levers.join(", ")}. ` +
          (ctx.invited === true
            ? `The buyer's message invites an add-on, so a bundle line may enter the cart.`
            : `The buyer did not invite an add-on. You may mention one; do not add it to the cart.`),
      },
    ];

    const started = Date.now();
    const runner = this.#client.beta.messages.toolRunner({
      model: this.#model,
      max_tokens: this.#maxTokens,
      max_iterations: this.#maxIterations,
      thinking: { type: "adaptive" },
      output_config: { effort: this.#effort },
      // The breakpoint sits at the end of the frozen system prompt. Everything
      // above it (tools, then system) is stable for the life of the merchant.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      tools,
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let last: Anthropic.Beta.BetaMessage | undefined;

    for await (const message of runner) {
      last = message;
      inputTokens += message.usage.input_tokens;
      outputTokens += message.usage.output_tokens;
      cacheRead += message.usage.cache_read_input_tokens ?? 0;
      // A server tool can pause a turn; the runner does not auto-resume.
      if (message.stop_reason === "pause_turn") {
        runner.pushMessages({ role: "assistant", content: message.content });
      }
    }

    const reply = last === undefined ? "" : textOf(last.content);
    const accepted = sink.accepted;

    // Attribution runs against the cart the gate approved, not the cart the model
    // hoped for. A lever pulled into an offer that was denied earned nothing.
    const pulled = levers.attribute(accepted?.proposal, asked);
    const final = cents(
      accepted?.feedback.computed_total_cents ?? accepted?.proposal.quoted_total_cents ?? 0,
    );

    return {
      reply,
      rounds: sink.list,
      ...(accepted === undefined ? {} : { settled: accepted }),
      ...(pulled.suggestion === undefined ? {} : { suggestion: pulled.suggestion }),
      ...(pulled.substitutions.length === 0 ? {} : { substitutions: pulled.substitutions }),
      value: basketValue(baseline, final, pulled.used),
      llm: {
        model: this.#model,
        effort: this.#effort,
        input_hash: promptHash(system + "\n" + turn.buyer_message),
        output_hash: sha256Hex(JSON.stringify({ reply, rounds: sink.list })),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        latency_ms: Date.now() - started,
      },
    };
  }
}

/**
 * The buyer's agent -- the counterparty, simulated.
 *
 * It has no access to the merchant's tools and no key of its own. It exists so
 * the demo is two agents negotiating rather than one agent talking to a script,
 * and so F1 has a genuine adversary applying price pressure.
 */
export class LlmBuyerAgent {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #effort: Effort;
  readonly #persona: string;

  constructor(persona: string, opts: LlmOptions = {}) {
    this.#persona = persona;
    this.#client = opts.client ?? clientFromEnv();
    this.#model = opts.model ?? modelFromEnv();
    this.#effort = opts.effort ?? "medium";
  }

  async respond(merchantMessage: string, history: readonly string[] = []): Promise<string> {
    let captured = "";
    const tools = buyerTools((m) => {
      captured = m;
    });

    await this.#client.beta.messages.toolRunner({
      model: this.#model,
      max_tokens: 2_000,
      max_iterations: 3,
      thinking: { type: "adaptive" },
      output_config: { effort: this.#effort },
      system: [{ type: "text", text: this.#persona, cache_control: { type: "ephemeral" } }],
      messages: [
        ...history.map<Anthropic.Beta.BetaMessageParam>((h) => ({ role: "user", content: h })),
        { role: "user", content: merchantMessage },
      ],
      tools,
    });

    return captured;
  }
}
