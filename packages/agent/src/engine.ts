import {
  type Decision,
  type HolderProof,
  type IntentToken,
  type Cents,
  type PricedCart,
  type Proposal,
  type RuleId,
  bpsOf,
  hashValue,
  newId,
  newNonce,
  cents,
  receiptFor,
  splitByWeight,
} from "@mercury/core";
import { type GateInput, cartHash, evaluate, repairProposal } from "@mercury/gate";
import { type EventType, Ledger } from "@mercury/ledger";
import { Store } from "@mercury/store";
import {
  type PaymentStatus,
  type PaymentPort,
  type RailPayment,
  type TransferInput,
  type WebhookEnvelope,
  type WebhookVerdict,
  TEST_PM_SUCCESS,
  WebhookGate,
  advanceStatus,
} from "@mercury/rail";

/**
 * The engine: the only place where a decision becomes an effect.
 *
 * The gate decides, The ledger records, the rail settles -- and this class is the
 * conductor that calls them in the right order. It contains no policy of its
 * own: every allow/deny in here came out of `evaluate()`.
 *
 * Deliberately free of any LLM. The whole settlement path, including all seven
 * engineered failures, runs deterministically with no API key and no network.
 * The Revenue Agent sits *above* this, and only ever supplies a Proposal.
 */

export interface EngineDeps {
  store: Store;
  ledger: Ledger;
  rail: PaymentPort;
  /** Injected for determinism in tests and the demo. */
  now?: () => Date;
  /** How long an intent token is valid. */
  tokenTtlMs?: number;
  /** Bounded retry budget for a declined payment (F2). */
  maxPaymentRetries?: number;
}

export interface ProposeInput {
  mandate_id: string;
  proposal: Proposal;
  session_id: string;
  /**
   * Proof that the caller holds this mandate. Required on every buyer-facing
   * path; the merchant's own console omits it and sets `requireHolderProof`
   * false, so the exemption is a visible argument rather than an implied one.
   */
  holder_proof?: HolderProof;
  requireHolderProof?: boolean;
  /** Attempt repair-and-retry once if the gate denies on a repairable rule. */
  autoRepair?: boolean;
  llm?: { model: string; effort: string; input_hash: string; output_hash: string };
}

export type ProposeResult =
  | {
      kind: "AUTHORISED";
      decision: Extract<Decision, { outcome: "ALLOW" }>;
      token: IntentToken;
      cart: PricedCart;
      order_id: string;
      repaired: boolean;
      adjustments: string[];
    }
  | {
      kind: "STEP_UP_REQUIRED";
      decision: Extract<Decision, { outcome: "ALLOW_WITH_STEPUP" }>;
      token: IntentToken;
      cart: PricedCart;
      order_id: string;
      link_url: string;
      repaired: boolean;
      adjustments: string[];
    }
  | { kind: "DENIED"; decision: Extract<Decision, { outcome: "DENY" }>; rule_id: RuleId };

export type SettleResult =
  | { kind: "CAPTURED"; payment_id: string; amount: Cents; consumed_cents: Cents }
  | { kind: "FAILED_FALLBACK_LINK"; attempts: number; link_url: string }
  | { kind: "REFUNDED"; refund_id: string; reason: string }
  | { kind: "REJECTED"; reason: string; rule_id?: RuleId };

/** Rules for which auto-repair can plausibly produce a legal proposal. */
const REPAIRABLE: ReadonlySet<RuleId> = new Set<RuleId>([
  "MARGIN.FLOOR_BREACH",
  "DISCOUNT.BPS_CAP",
]);

export class Engine {
  readonly #store: Store;
  readonly #ledger: Ledger;
  readonly #rail: PaymentPort;
  readonly #now: () => Date;
  readonly #tokenTtlMs: number;
  readonly #maxRetries: number;
  readonly #gate: WebhookGate;

  constructor(deps: EngineDeps) {
    this.#store = deps.store;
    this.#ledger = deps.ledger;
    this.#rail = deps.rail;
    this.#now = deps.now ?? (() => new Date());
    this.#tokenTtlMs = deps.tokenTtlMs ?? 5 * 60_000;
    this.#maxRetries = deps.maxPaymentRetries ?? 2;
    this.#gate = new WebhookGate(this.#rail, {
      has: (id) => this.#store.hasSeenEvent(id),
      add: (id) => this.#store.markEventSeen(id),
    });
  }

  /* ------------------------------------------------------------------ log */

  #log(
    event_type: EventType,
    body: Omit<Parameters<Ledger["append"]>[0], "event_type" | "actor"> & {
      actor?: Parameters<Ledger["append"]>[0]["actor"];
    },
  ): number {
    const { actor, ...rest } = body;
    return this.#ledger.append({
      actor: actor ?? { type: "gate", id: "gate" },
      event_type,
      ts: this.#now().toISOString(),
      ...rest,
    }).seq;
  }

  /* -------------------------------------------------------------- propose */

  /**
   * Take a proposal through the gate. On a repairable denial, clamp the offer
   * to the lowest legal price and re-evaluate once (F1) -- the negotiation
   * continues rather than collapsing.
   */
  async propose(input: ProposeInput): Promise<ProposeResult> {
    const signed = this.#store.getMandate(input.mandate_id);
    if (signed === undefined) {
      throw new EngineError(`no such mandate: ${input.mandate_id}`);
    }
    const profile = this.#store.getMerchant(input.proposal.merchant_id);
    if (profile === undefined) {
      throw new EngineError(`no such merchant: ${input.proposal.merchant_id}`);
    }

    const registeredKey = this.#store.getPrincipalKey(signed.mandate.principal_id) ?? "";
    const state = this.#store.getMandateState(input.mandate_id) ?? {
      consumed_cents: cents(0),
      txn_count: 0,
      status: "active" as const,
    };
    const catalog = this.#store.catalogFor(input.proposal.merchant_id);

    const baseInput = (proposal: Proposal): GateInput => ({
      signed_mandate: signed,
      registered_public_key: registeredKey,
      profile,
      catalog,
      proposal,
      ledger_state: { consumed_cents: state.consumed_cents, txn_count: state.txn_count },
      now: this.#now(),
      frozen: this.#store.isFrozen(),
      spent_token_ids: this.#store.spentTokenIds(),
      require_holder_proof: input.requireHolderProof ?? false,
      ...(input.holder_proof === undefined ? {} : { holder_proof: input.holder_proof }),
      seen_holder_nonces: this.#store.seenHolderNonces(),
    });

    this.#log("OFFER_PROPOSED", {
      actor: { type: "merchant_agent", id: "agt_revenue" },
      session_id: input.session_id,
      delegation_scope: { mandate_id: input.mandate_id, scope_hash: hashValue(signed.mandate.scope) },
      ...(input.llm === undefined ? {} : { llm: { ...input.llm } }),
      detail: {
        lines: input.proposal.lines.length,
        quoted_total_cents: input.proposal.quoted_total_cents,
        rationale: input.proposal.rationale,
      },
    });

    let proposal = input.proposal;
    let decision = evaluate(baseInput(proposal));
    let repaired = false;
    let adjustments: string[] = [];

    if (
      decision.outcome === "DENY" &&
      (input.autoRepair ?? true) &&
      REPAIRABLE.has(decision.violation.rule_id)
    ) {
      this.#log("DRIFT_BLOCKED", {
        session_id: input.session_id,
        decision: {
          outcome: "DENY",
          rule_ids: [decision.violation.rule_id],
          evidence: [decision.violation],
        },
        detail: { note: "repairable violation; clamping to the lowest legal price" },
      });

      const repair = repairProposal(proposal, profile, catalog);
      if (repair.changed) {
        proposal = repair.proposal;
        adjustments = repair.adjustments;
        repaired = true;
        decision = evaluate(baseInput(proposal));
        this.#log("REPRICED", {
          session_id: input.session_id,
          detail: { adjustments, new_total_cents: proposal.quoted_total_cents },
        });
      }
    }

    this.#log("GATE_DECISION", {
      session_id: input.session_id,
      delegation_scope: { mandate_id: input.mandate_id, scope_hash: hashValue(signed.mandate.scope) },
      envelope: this.#envelope(input.mandate_id),
      decision: {
        outcome: decision.outcome,
        rule_ids: decision.rules.map((r) => r.rule_id),
        evidence: decision.rules,
      },
    });

    if (decision.outcome === "DENY") {
      const rule = decision.violation.rule_id;
      const breachEvent: EventType =
        rule === "DRIFT.AMOUNT_MISMATCH"
          ? "DRIFT_BLOCKED"
          : rule === "TOKEN.REPLAY"
            ? "REPLAY_BLOCKED"
            : rule === "INVENTORY.INSUFFICIENT"
              ? "INVENTORY_CONFLICT"
              : rule === "CIRCUIT.FROZEN"
                ? "CIRCUIT_FROZEN"
                : "MANDATE_BREACH_BLOCKED";

      this.#log(breachEvent, {
        session_id: input.session_id,
        decision: { outcome: "DENY", rule_ids: [rule], evidence: [decision.violation] },
        detail: { note: "no rail call was made" },
      });
      return { kind: "DENIED", decision, rule_id: rule };
    }

    /* The proof was accepted, so burn its nonce. Deliberately after the
     * decision: a proof that failed for some other reason must not consume the
     * nonce it would need to retry with. */
    if (input.requireHolderProof === true && input.holder_proof !== undefined) {
      this.#store.useHolderNonce(input.holder_proof.nonce);
    }

    /* Allowed. Reserve stock before anything irreversible happens. */
    const cart = decision.cart;
    const reserved: { sku: string; qty: number }[] = [];
    for (const line of cart.lines) {
      const r = this.#store.reserveStock(line.sku, line.qty);
      if (!r.ok) {
        for (const back of reserved) this.#store.releaseStock(back.sku, back.qty);
        this.#log("INVENTORY_CONFLICT", {
          session_id: input.session_id,
          detail: { sku: line.sku, requested: line.qty, reason: r.reason },
        });
        const violation = {
          rule_id: "INVENTORY.INSUFFICIENT" as const,
          passed: false,
          observed: r.available,
          limit: line.qty,
          message: `Stock for ${line.sku} was taken by another buyer before this cart settled.`,
        };
        return {
          kind: "DENIED",
          decision: { outcome: "DENY", rules: [...decision.rules, violation], violation },
          rule_id: "INVENTORY.INSUFFICIENT",
        };
      }
      reserved.push({ sku: line.sku, qty: line.qty });
    }

    /* Mint a single-use, cart-bound, expiring authorisation. */
    const hash = cartHash(cart);
    const issuedAt = this.#now();
    const token: IntentToken = {
      token_id: newId("intentToken"),
      mandate_id: input.mandate_id,
      cart_hash: hash,
      amount_cents: decision.computed_cents,
      nonce: newNonce(),
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + this.#tokenTtlMs).toISOString(),
    };
    this.#store.issueToken(token);

    /* The order amount comes from the gate, never from the proposal. */
    const order = await this.#rail.createOrder({
      amount: decision.computed_cents,
      receipt: receiptFor(token.token_id),
      notes: {
        mercury: "1",
        mandate_id: input.mandate_id,
        agent_id: signed.mandate.agent_id,
        intent_token_id: token.token_id,
        cart_hash: hash,
        ledger_seq: String(this.#ledger.count() + 1),
      },
    });

    this.#store.putOrder({
      order_id: order.id,
      mandate_id: input.mandate_id,
      token_id: token.token_id,
      cart_hash: hash,
      amount: decision.computed_cents,
      status: "created",
      merchant_id: profile.merchant_id,
    });

    this.#log("ORDER_CREATED", {
      actor: { type: "rail", id: order.id },
      session_id: input.session_id,
      intent_token_id: token.token_id,
      cart_mandate_hash: hash,
      envelope: this.#envelope(input.mandate_id),
      provider: { order_id: order.id },
      detail: {
        amount_cents: decision.computed_cents,
        receipt: order.receipt,
        // Recorded so a later compensation knows exactly what stock to put
        // back. The orders table keeps only a hash of the cart.
        lines: cart.lines.map((l) => ({
          sku: l.sku,
          qty: l.qty,
          line_total_cents: l.line_total_cents,
        })),
      },
    });

    if (decision.outcome === "ALLOW_WITH_STEPUP") {
      const link = await this.#rail.createPaymentLink({
        amount: decision.computed_cents,
        description: `Approve ${cart.lines.length} item(s) from ${profile.display_name}`,
        reference_id: token.token_id,
        notes: { mandate_id: input.mandate_id, order_id: order.id },
      });
      this.#log("STEPUP_ISSUED", {
        session_id: input.session_id,
        intent_token_id: token.token_id,
        provider: { order_id: order.id, link_id: link.id },
        detail: { reason: decision.step_up, url: link.url },
      });
      return {
        kind: "STEP_UP_REQUIRED",
        decision,
        token,
        cart,
        order_id: order.id,
        link_url: link.url,
        repaired,
        adjustments,
      };
    }

    return {
      kind: "AUTHORISED",
      decision,
      token,
      cart,
      order_id: order.id,
      repaired,
      adjustments,
    };
  }

  /* --------------------------------------------------------------- settle */

  /**
   * Redeem an intent token against an order.
   *
   * Spends the token first (F7), then attempts payment with a bounded retry
   * budget (F2) -- authorise, then capture, so nothing is drawn down until the
   * rail has confirmed the money is there -- and only then draws down the
   * envelope.
   */
  async settle(args: {
    order_id: string;
    token_id: string;
    session_id: string;
    /**
     * The payment method to charge. Defaults to Stripe's always-succeeds test
     * card; the decline scenario passes `TEST_PM_DECLINED`. In live mode this
     * is a real `pm_...` id; the buyer never chooses it through any API.
     */
    payment_method?: string;
    /** Observe each attempt as it lands -- for a live narration, never for control. */
    onAttempt?: (a: { attempt: number; payment: RailPayment; failed: boolean }) => void | Promise<void>;
  }): Promise<SettleResult> {
    const order = this.#store.getOrder(args.order_id);
    if (order === undefined) return { kind: "REJECTED", reason: `no such order: ${args.order_id}` };

    const spend = this.#store.spendToken(args.token_id);
    if (!spend.ok) {
      this.#log("REPLAY_BLOCKED", {
        session_id: args.session_id,
        intent_token_id: args.token_id,
        decision: {
          outcome: "DENY",
          rule_ids: ["TOKEN.REPLAY"],
          evidence: [
            {
              rule_id: "TOKEN.REPLAY",
              passed: false,
              observed: 1,
              limit: 0,
              message: `Intent token ${args.token_id} is ${spend.reason}.`,
            },
          ],
        },
        detail: { note: "no duplicate order was created" },
      });
      return { kind: "REJECTED", reason: spend.reason, rule_id: "TOKEN.REPLAY" };
    }

    const paymentMethod = args.payment_method ?? TEST_PM_SUCCESS;
    let attempts = 0;
    let lastFailure = "";

    while (attempts <= this.#maxRetries) {
      attempts += 1;
      const attempt = await this.#rail.attemptPayment(args.order_id, paymentMethod);
      const paymentId = attempt.payment.id;
      await args.onAttempt?.({ attempt: attempts, payment: attempt.payment, failed: attempt.failed });

      if (attempt.failed) {
        lastFailure = paymentId;
        this.#store.setPaymentStatus(args.order_id, "failed", paymentId);
        this.#log("PAYMENT_FAILED", {
          actor: { type: "rail", id: paymentId },
          session_id: args.session_id,
          provider: { order_id: args.order_id, payment_id: paymentId },
          detail: {
            attempt: attempts,
            payment_method: paymentMethod,
            ...(attempt.payment.error_code === undefined ? {} : { error_code: attempt.payment.error_code }),
          },
        });
        if (attempts <= this.#maxRetries) {
          this.#log("RETRY_BOUNDED", {
            session_id: args.session_id,
            detail: {
              attempt: attempts,
              max_retries: this.#maxRetries,
              note: "retry re-checked against the remaining envelope",
            },
          });
          continue;
        }
        break;
      }

      /*
       * Authorised, not yet captured. The capture is a second, explicit call
       * for the amount the gate computed -- so the money that moves is the
       * gate's figure, and an authorisation the rail reported but we never
       * confirmed can never turn into a charge.
       */
      const captured = await this.#rail.capturePayment(paymentId, cents(order.amount));
      this.#store.setOrderStatus(args.order_id, "paid", captured.id);
      // The payment FSM advances here as well as on the webhook, so a genuine
      // `payment.captured` delivery arriving later is a no-op rather than news.
      this.#store.setPaymentStatus(args.order_id, "captured", captured.id);
      const state = this.#store.consumeEnvelope(order.mandate_id, cents(order.amount));

      this.#log("PAYMENT_CAPTURED", {
        actor: { type: "rail", id: captured.id },
        session_id: args.session_id,
        intent_token_id: args.token_id,
        cart_mandate_hash: order.cart_hash,
        envelope: this.#envelope(order.mandate_id),
        provider: { order_id: args.order_id, payment_id: captured.id, signature_verified: true },
        detail: { amount_cents: order.amount, attempts },
      });

      await this.#settleSplits({
        order_id: args.order_id,
        payment_id: captured.id,
        amount: cents(order.amount),
        cart_hash: order.cart_hash,
        session_id: args.session_id,
      });

      return {
        kind: "CAPTURED",
        payment_id: captured.id,
        amount: cents(order.amount),
        consumed_cents: state.consumed_cents,
      };
    }

    /* Retries exhausted -- hand a human a hosted payment page rather than looping. */
    const link = await this.#rail.createPaymentLink({
      amount: cents(order.amount),
      description: "Payment retry - complete this order yourself",
      reference_id: `_retry`,
      notes: { order_id: args.order_id, mandate_id: order.mandate_id },
    });
    this.#log("STEPUP_ISSUED", {
      session_id: args.session_id,
      provider: { order_id: args.order_id, link_id: link.id, payment_id: lastFailure },
      detail: {
        reason: "AUTOMATED_RETRIES_EXHAUSTED",
        attempts,
        url: link.url,
        note: "handing control back to a human rather than retrying indefinitely",
      },
    });
    return { kind: "FAILED_FALLBACK_LINK", attempts, link_url: link.url };
  }

  /**
   * F3 recovery: money was captured but the goods cannot be delivered.
   * Refund automatically, put the stock back, and restore the envelope, so the
   * principal is left exactly where they started. Zero financial leakage.
   */
  async compensate(args: {
    order_id: string;
    payment_id: string;
    session_id: string;
    reason: string;
    restore: { sku: string; qty: number }[];
  }): Promise<SettleResult> {
    const order = this.#store.getOrder(args.order_id);
    if (order === undefined) return { kind: "REJECTED", reason: `no such order: ${args.order_id}` };

    const refund = await this.#rail.refund(args.payment_id, cents(order.amount), {
      reason: args.reason,
      order_id: args.order_id,
    });

    for (const r of args.restore) this.#store.releaseStock(r.sku, r.qty);
    this.#store.restoreEnvelope(order.mandate_id, cents(order.amount));
    this.#store.setOrderStatus(args.order_id, "refunded");
    this.#store.setPaymentStatus(args.order_id, "refunded");

    this.#log("AUTO_REFUND_ISSUED", {
      actor: { type: "rail", id: refund.id },
      session_id: args.session_id,
      envelope: this.#envelope(order.mandate_id),
      provider: { order_id: args.order_id, payment_id: args.payment_id, refund_id: refund.id },
      detail: {
        reason: args.reason,
        amount_cents: order.amount,
        note: "stock released and envelope restored; principal is whole",
      },
    });

    return { kind: "REFUNDED", refund_id: refund.id, reason: args.reason };
  }

  /* ------------------------------------------------------- split settlement */

  /**
   * Pay the suppliers out of a captured payment (split settlement).
   *
   * A B2B basket is one cart, one payment and several sellers. The platform's
   * commission comes off the top -- so a supplier's share is never quietly
   * reduced by a fee it did not agree to -- and the rest is divided by what
   * each supplier actually sold, to the cent, using largest-remainder so the
   * transfers sum to exactly what was captured.
   *
   * Quick-commerce sells its own inventory, so no line names a supplier, so
   * nothing splits and no transfer is made. Same code, same rail, different
   * data: the only thing that decides is the catalogue.
   *
   * A failure here never unwinds the capture. The money is legitimately the
   * merchant's the moment it is captured; a transfer that did not go through
   * is an operational problem to retry, not a reason to refund a buyer who did
   * nothing wrong. It is recorded either way.
   */
  async #settleSplits(args: {
    order_id: string;
    payment_id: string;
    amount: Cents;
    cart_hash: string;
    session_id: string;
  }): Promise<void> {
    const lines = this.#linesOf(args.cart_hash);
    if (lines.length === 0) return;

    const profile = this.#store.getMerchant(this.#merchantOf(lines));
    const settlement = profile?.settlement;
    if (profile === undefined || settlement === undefined) return;

    // What each supplier sold, in cents. Own-inventory lines are not a split.
    const bySupplier = new Map<string, number>();
    for (const line of lines) {
      const item = this.#store.getItem(line.sku);
      const account = item?.supplier_account_id;
      if (item === undefined || account === undefined) continue;
      bySupplier.set(account, (bySupplier.get(account) ?? 0) + line.line_total_cents);
    }
    if (bySupplier.size === 0) return;

    const commission = bpsOf(args.amount, settlement.commission_bps);
    const distributable = cents(args.amount - commission);
    const accounts = [...bySupplier.keys()];
    const shares = splitByWeight(distributable, accounts.map((a) => bySupplier.get(a) ?? 0));

    const transfers: TransferInput[] = accounts.map((account, i) => ({
      account,
      amount: shares[i] ?? cents(0),
      notes: { order_id: args.order_id, mercury: "1" },
    }));
    if (settlement.commission_bps > 0) {
      transfers.push({
        account: settlement.commission_account_id,
        amount: commission,
        notes: { order_id: args.order_id, kind: "platform_commission" },
      });
    }

    try {
      const made = await this.#rail.createTransfers(args.payment_id, transfers);
      this.#log("SETTLEMENT_SPLIT", {
        actor: { type: "rail", id: args.payment_id },
        session_id: args.session_id,
        provider: {
          order_id: args.order_id,
          payment_id: args.payment_id,
          transfer_ids: made.map((t) => t.id),
        },
        detail: {
          captured_cents: args.amount,
          commission_cents: commission,
          commission_bps: settlement.commission_bps,
          legs: transfers.map((t) => ({ account: t.account, amount_cents: t.amount })),
          note: "transfers sum to the captured amount exactly",
        },
      });
    } catch (e) {
      this.#log("SETTLEMENT_SPLIT", {
        actor: { type: "system", id: "mercury" },
        session_id: args.session_id,
        provider: { order_id: args.order_id, payment_id: args.payment_id },
        detail: {
          failed: true,
          reason: e instanceof Error ? e.message : String(e),
          note: "capture stands; the split needs an operator, not a refund",
        },
      });
    }
  }

  /** The priced lines of an order, recovered from the ORDER_CREATED entry. */
  #linesOf(cartHash: string): { sku: string; qty: number; line_total_cents: number }[] {
    const entry = this.#ledger
      .byEventType("ORDER_CREATED")
      .find((e) => e.cart_mandate_hash === cartHash);
    const lines = (entry?.detail as
      | { lines?: { sku: string; qty: number; line_total_cents?: number }[] }
      | undefined)?.lines;
    return (lines ?? []).map((l) => ({
      sku: l.sku,
      qty: l.qty,
      line_total_cents: l.line_total_cents ?? 0,
    }));
  }

  /** Which merchant a cart belongs to, taken from the goods themselves. */
  #merchantOf(lines: { sku: string }[]): string {
    for (const l of lines) {
      const item = this.#store.getItem(l.sku);
      if (item !== undefined) return item.merchant_id;
    }
    return "";
  }

  /* -------------------------------------------------------------- webhooks */

  /** F4/F5: verify, dedupe, and record. Never mutates order state on rejection. */
  handleWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookVerdict {
    const verdict = this.#gate.handle(rawBody, headers);

    if (verdict.kind === "REJECTED_SIGNATURE" || verdict.kind === "REJECTED_MALFORMED") {
      this.#log("WEBHOOK_REJECTED", {
        actor: { type: "system", id: "webhook" },
        provider: { signature_verified: false },
        detail: { kind: verdict.kind, reason: verdict.reason, note: "order state untouched" },
      });
      return verdict;
    }

    if (verdict.kind === "DUPLICATE") {
      this.#log("WEBHOOK_DEDUPED", {
        actor: { type: "system", id: "webhook" },
        provider: { event_id: verdict.event_id },
        detail: { note: "already processed; no-op" },
      });
      return verdict;
    }

    const applied = this.#applyWebhook(verdict.event);

    this.#log("WEBHOOK_ACCEPTED", {
      actor: { type: "rail", id: verdict.event_id },
      provider: {
        event_id: verdict.event_id,
        signature_verified: true,
        ...(applied.order_id === undefined ? {} : { order_id: applied.order_id }),
        ...(applied.payment_id === undefined ? {} : { payment_id: applied.payment_id }),
      },
      detail: {
        event: verdict.event.event,
        payment_status_before: applied.before,
        payment_status_after: applied.after,
        applied: applied.applied,
        note: applied.note,
      },
    });
    return verdict;
  }

  /**
   * Fold one accepted event into the payment's state.
   *
   * Stripe does not guarantee delivery order, so state advances by rank and
   * never regresses: a `captured` that overtakes its own `authorized` still
   * converges to `captured`, and the late `authorized` is recorded and
   * discarded rather than winding the payment backwards (F5).
   */
  #applyWebhook(event: WebhookEnvelope): {
    order_id?: string;
    payment_id?: string;
    before: string;
    after: string;
    applied: boolean;
    note: string;
  } {
    const payment = event.payload.payment?.entity;
    const refund = event.payload.refund?.entity;
    const paymentId = payment?.id ?? refund?.payment_id;

    if (paymentId === undefined) {
      return { before: "n/a", after: "n/a", applied: false, note: "event carries no payment" };
    }

    const orderId = payment?.order_id ?? this.#store.orderIdForPayment(paymentId);
    const order = orderId === undefined ? undefined : this.#store.getOrder(orderId);
    if (order === undefined) {
      // A genuine, correctly signed event for an order Mercury never created.
      // Recorded, not applied: the signature proves the sender, not the claim.
      return {
        payment_id: paymentId,
        before: "unknown",
        after: "unknown",
        applied: false,
        note: `no local order for payment ${paymentId}`,
      };
    }

    const before = order.payment_status as PaymentStatus;
    const observed: PaymentStatus =
      refund !== undefined ? "refunded" : (payment?.status ?? before);
    const after = advanceStatus(before, observed);

    if (after !== before) this.#store.setPaymentStatus(order.order_id, after, paymentId);

    return {
      order_id: order.order_id,
      payment_id: paymentId,
      before,
      after,
      applied: after !== before,
      note:
        after === before
          ? `observed ${observed} does not advance ${before}; ignored`
          : `payment advanced ${before} -> ${after}`,
    };
  }

  /** Close an envelope and record the residual released back to the principal. */
  closeEnvelope(mandateId: string, sessionId: string): { released_cents: Cents } {
    const result = this.#store.closeEnvelope(mandateId);
    this.#log("ENVELOPE_RESIDUAL_RELEASED", {
      actor: { type: "system", id: "mercury" },
      session_id: sessionId,
      delegation_scope: { mandate_id: mandateId, scope_hash: "" },
      envelope: this.#envelope(mandateId),
      detail: {
        released_cents: result.released_cents,
        note: "unspent authority returned to the principal, per the budget-hold model",
      },
    });
    return result;
  }

  setFrozen(frozen: boolean, sessionId: string): void {
    this.#store.setFrozen(frozen);
    this.#log(frozen ? "CIRCUIT_FROZEN" : "CIRCUIT_UNFROZEN", {
      actor: { type: "human", id: "merchant" },
      session_id: sessionId,
      detail: { frozen },
    });
  }

  /** Total by construction: an unknown mandate reports a zero envelope rather
   *  than undefined, so every ledger entry carries budget context. */
  #envelope(mandateId: string): { reserved_cents: number; consumed_cents: number; remaining_cents: number } {
    const signed = this.#store.getMandate(mandateId);
    const state = this.#store.getMandateState(mandateId);
    if (signed === undefined || state === undefined) {
      return { reserved_cents: 0, consumed_cents: 0, remaining_cents: 0 };
    }
    return {
      reserved_cents: signed.mandate.reserved_cents,
      consumed_cents: state.consumed_cents,
      remaining_cents: Math.max(0, signed.mandate.reserved_cents - state.consumed_cents),
    };
  }
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}
