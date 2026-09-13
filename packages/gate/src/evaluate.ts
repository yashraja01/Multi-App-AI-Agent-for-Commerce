import {
  type CartLine,
  type CatalogItem,
  type Decision,
  type HolderProof,
  type IntentToken,
  type MerchantProfile,
  type Cents,
  type PricedCart,
  type Proposal,
  type RuleEval,
  type RuleId,
  type SignedBudgetMandate,
  type StepUpReason,
  formatUSD,
  hashValue,
  holderChallenge,
  newId,
  cents,
  verifyValue,
} from "@mercury/core";
import { buildLine, discountBps, marginFloor, totalLines } from "./pricing.js";

/**
 * Gate -- the gate.
 *
 * One pure function. No I/O, no clock, no randomness, no model. Every input it
 * needs is passed in, so the same inputs always produce the same Decision and
 * the whole thing is property-testable.
 *
 * The invariant this file exists to enforce: the amount the model proposed is
 * never the amount that moves. The gate reprices every line from the catalogue,
 * totals it itself, and hard-denies if the model's arithmetic disagrees.
 */

export interface LedgerState {
  /** Cents already drawn down from this envelope. */
  consumed_cents: Cents;
  /** Debits already made against this envelope. */
  txn_count: number;
}

export interface GateInput {
  signed_mandate: SignedBudgetMandate;
  /** The public key the agent registry holds for this principal. */
  registered_public_key: string;
  profile: MerchantProfile;
  /** sku -> item, for the merchant in question. */
  catalog: ReadonlyMap<string, CatalogItem>;
  proposal: Proposal;
  ledger_state: LedgerState;
  /** Injected so the function stays pure. */
  now: Date;
  /** Merchant kill switch. */
  frozen: boolean;
  /** Intent tokens already spent, for replay detection. */
  spent_token_ids?: ReadonlySet<string>;
  /** Present when settling: the token being redeemed. */
  intent_token?: IntentToken;

  /**
   * Demand proof that the caller holds this mandate.
   *
   * True on every buyer-facing surface. False for the merchant's own console,
   * where the caller is the merchant rather than a delegated agent -- expressed
   * as a flag so the exemption is visible in the input rather than implied by
   * which code path happened to build it.
   */
  require_holder_proof?: boolean;
  holder_proof?: HolderProof;
  /** Nonces already used, so a replayed proof is refused. */
  seen_holder_nonces?: ReadonlySet<string>;
  /** How far from `now` a proof may be issued. Default 2 minutes. */
  holder_proof_skew_ms?: number;
}

/* -------------------------------------------------------------- rule helpers */

function ok(rule_id: RuleId, observed: number, limit: number, message: string): RuleEval {
  return { rule_id, passed: true, observed, limit, message };
}

function bad(rule_id: RuleId, observed: number, limit: number, message: string): RuleEval {
  return { rule_id, passed: false, observed, limit, message };
}

function deny(rules: RuleEval[], violation: RuleEval): Decision {
  return { outcome: "DENY", rules: [...rules, violation], violation };
}

/* ------------------------------------------------------------------ evaluate */

export function evaluate(input: GateInput): Decision {
  const rules: RuleEval[] = [];
  const { signed_mandate, profile, catalog, proposal, ledger_state, now } = input;
  const mandate = signed_mandate.mandate;

  /* 1. Kill switch. Checked first so a frozen merchant short-circuits everything. */
  if (input.frozen) {
    return deny(rules, bad("CIRCUIT.FROZEN", 1, 0, "Merchant has frozen all agent activity."));
  }
  rules.push(ok("CIRCUIT.FROZEN", 0, 0, "Agent activity is not frozen."));

  /* 2. Signature. Limits inside an unsigned mandate mean nothing. */
  const keyMatches = signed_mandate.public_key === input.registered_public_key;
  const sigValid =
    keyMatches && verifyValue(mandate, signed_mandate.signature, signed_mandate.public_key);
  if (!sigValid) {
    return deny(
      rules,
      bad(
        "MANDATE.SIGNATURE",
        0,
        1,
        keyMatches
          ? "Mandate signature does not verify: the mandate was altered after signing."
          : "Mandate was signed by a key that is not registered to this principal.",
      ),
    );
  }
  rules.push(ok("MANDATE.SIGNATURE", 1, 1, "Mandate signature verifies against the registered key."));

  const t = now.getTime();

  /* 2b. Proof of holder.
   *
   * The signature above proves the envelope is genuine. It does not prove the
   * caller is the agent the envelope was issued to -- without this check a
   * mandate id is a bearer token, and anyone who learns one can spend it.
   *
   * The key is read from inside the signed mandate, so this verifies against
   * what the *human* authorised rather than against anything our own database
   * says. Required only where the caller is external; the merchant's own
   * console passes `require_holder_proof: false`, which is explicit and shows
   * up in the rule list rather than being a silent bypass. */
  if (input.require_holder_proof === true) {
    const proof = input.holder_proof;
    if (proof === undefined) {
      return deny(
        rules,
        bad("HOLDER.PROOF_MISSING", 0, 1, "No proof of holder was supplied for this mandate."),
      );
    }
    if (proof.mandate_id !== mandate.mandate_id) {
      return deny(
        rules,
        bad(
          "HOLDER.SIGNATURE",
          0,
          1,
          `Proof is for ${proof.mandate_id}, not ${mandate.mandate_id}.`,
        ),
      );
    }

    const skew = input.holder_proof_skew_ms ?? 120_000;
    const issued = Date.parse(proof.issued_at);
    const age = Number.isNaN(issued) ? Number.POSITIVE_INFINITY : Math.abs(t - issued);
    if (age > skew) {
      return deny(
        rules,
        bad(
          "HOLDER.STALE",
          Number.isFinite(age) ? age : skew + 1,
          skew,
          `Proof was issued at ${proof.issued_at}, outside the ${skew}ms window.`,
        ),
      );
    }
    rules.push(ok("HOLDER.STALE", age, skew, "Proof is within the accepted clock skew."));

    if (input.seen_holder_nonces?.has(proof.nonce) === true) {
      return deny(
        rules,
        bad("HOLDER.NONCE_REPLAY", 1, 0, `Proof nonce ${proof.nonce} has already been used.`),
      );
    }
    rules.push(ok("HOLDER.NONCE_REPLAY", 0, 0, "Proof nonce is unused."));

    const holds = verifyValue(
      holderChallenge(proof),
      proof.signature,
      mandate.agent_public_key,
    );
    if (!holds) {
      return deny(
        rules,
        bad(
          "HOLDER.SIGNATURE",
          0,
          1,
          "Proof does not verify against the agent key named in the signed mandate.",
        ),
      );
    }
    rules.push(
      ok("HOLDER.SIGNATURE", 1, 1, "Caller holds the agent key this mandate delegates to."),
    );
  }

  /* 3. Validity window. */
  const notBefore = Date.parse(mandate.not_before);
  const expiresAt = Date.parse(mandate.expires_at);
  if (t < notBefore || t >= expiresAt) {
    return deny(
      rules,
      bad(
        "MANDATE.EXPIRY",
        t,
        expiresAt,
        t < notBefore
          ? `Mandate is not valid until ${mandate.not_before}.`
          : `Mandate expired at ${mandate.expires_at}.`,
      ),
    );
  }
  rules.push(ok("MANDATE.EXPIRY", t, expiresAt, "Mandate is within its validity window."));

  /* 4. Merchant scope. */
  if (!mandate.scope.merchant_allowlist.includes(proposal.merchant_id)) {
    return deny(
      rules,
      bad(
        "SCOPE.MERCHANT_ALLOWLIST",
        0,
        1,
        `Merchant ${proposal.merchant_id} is not in the mandate allowlist.`,
      ),
    );
  }
  rules.push(ok("SCOPE.MERCHANT_ALLOWLIST", 1, 1, "Merchant is in the mandate allowlist."));

  /* 4b. The shape of the order, as the merchant limits it.
   *
   * These are checked before the catalogue is touched, because they are
   * properties of the proposal itself -- how many lines, how many units -- and a
   * cart refused for its shape should be refused before anything is priced.
   *
   * An unset limit is not a limit: `undefined` means the merchant never asked
   * for one, and the rule is recorded as passing with a limit of 0 so the rule
   * list still shows it was considered. */
  const lineCount = proposal.lines.length;
  if (profile.max_order_lines !== undefined && lineCount > profile.max_order_lines) {
    return deny(
      rules,
      bad(
        "ORDER.LINE_CAP",
        lineCount,
        profile.max_order_lines,
        `Cart has ${lineCount} lines; this merchant accepts at most ${profile.max_order_lines} in one order.`,
      ),
    );
  }
  rules.push(
    ok("ORDER.LINE_CAP", lineCount, profile.max_order_lines ?? 0, "Within the merchant line limit."),
  );

  const unitCount = proposal.lines.reduce((n, l) => n + l.qty, 0);
  if (profile.max_order_units !== undefined && unitCount > profile.max_order_units) {
    return deny(
      rules,
      bad(
        "ORDER.UNIT_CAP",
        unitCount,
        profile.max_order_units,
        `Cart has ${unitCount} units; this merchant accepts at most ${profile.max_order_units} in one order.`,
      ),
    );
  }
  rules.push(
    ok("ORDER.UNIT_CAP", unitCount, profile.max_order_units ?? 0, "Within the merchant unit limit."),
  );

  /* 5-9. Per-line checks and repricing. */
  const allowedCategories = new Set(mandate.scope.category_allowlist);
  /*
   * What the merchant permits its own agent to sell. Absent means the whole
   * taxonomy -- a merchant that has never narrowed anything is not thereby
   * selling nothing.
   */
  const merchantCategories =
    profile.agent_categories === undefined ? undefined : new Set(profile.agent_categories);
  const lines: CartLine[] = [];

  for (const pl of proposal.lines) {
    const item = catalog.get(pl.sku);

    if (item === undefined) {
      return deny(
        rules,
        bad("CATALOG.UNKNOWN_SKU", 0, 1, `SKU ${pl.sku} is not in the merchant catalogue.`),
      );
    }

    if (!allowedCategories.has(item.category)) {
      return deny(
        rules,
        bad(
          "SCOPE.CATEGORY_ALLOWLIST",
          0,
          1,
          `Category "${item.category}" (SKU ${pl.sku}) is not in the mandate allowlist.`,
        ),
      );
    }

    if (pl.qty < item.moq) {
      return deny(
        rules,
        bad(
          "CATALOG.BELOW_MOQ",
          pl.qty,
          item.moq,
          `SKU ${pl.sku} has a minimum order quantity of ${item.moq}; ${pl.qty} requested.`,
        ),
      );
    }

    if (merchantCategories !== undefined && !merchantCategories.has(item.category)) {
      return deny(
        rules,
        bad(
          "SCOPE.MERCHANT_CATEGORIES",
          0,
          1,
          `This merchant does not sell "${item.category}" through its agent (SKU ${pl.sku}).`,
        ),
      );
    }

    if (item.stock < pl.qty) {
      return deny(
        rules,
        bad(
          "INVENTORY.INSUFFICIENT",
          item.stock,
          pl.qty,
          `SKU ${pl.sku} has ${item.stock} in stock; ${pl.qty} requested.`,
        ),
      );
    }

    /*
     * Safety stock. Checked after the plain stock check so the two failures
     * stay distinguishable: "we do not have that many" and "we have that many
     * but will not sell down to nothing" are different sentences, and a
     * merchant reading its own audit trail should be able to tell them apart.
     */
    const reserve = profile.reserve_units ?? 0;
    if (reserve > 0 && item.stock - pl.qty < reserve) {
      return deny(
        rules,
        bad(
          "INVENTORY.RESERVE",
          item.stock - pl.qty,
          reserve,
          `SKU ${pl.sku} would be left with ${item.stock - pl.qty} in stock; this merchant holds ${reserve} back.`,
        ),
      );
    }

    const floor = marginFloor(item, profile);
    if (pl.offer_unit_cents < floor) {
      return deny(
        rules,
        bad(
          "MARGIN.FLOOR_BREACH",
          pl.offer_unit_cents,
          floor,
          `SKU ${pl.sku} offered at ${formatUSD(pl.offer_unit_cents)}, below the margin floor of ${formatUSD(floor)}.`,
        ),
      );
    }

    const dBps = discountBps(item, pl.offer_unit_cents);
    if (dBps > profile.max_discount_bps) {
      return deny(
        rules,
        bad(
          "DISCOUNT.BPS_CAP",
          dBps,
          profile.max_discount_bps,
          `SKU ${pl.sku} discounted ${dBps}bps off list; the ceiling is ${profile.max_discount_bps}bps.`,
        ),
      );
    }

    lines.push(buildLine({ item, qty: pl.qty, unit: pl.offer_unit_cents }));
  }

  rules.push(ok("SCOPE.CATEGORY_ALLOWLIST", 1, 1, "All line categories are in the mandate allowlist."));
  rules.push(
    ok(
      "SCOPE.MERCHANT_CATEGORIES",
      1,
      1,
      merchantCategories === undefined
        ? "The merchant sells its whole taxonomy through the agent."
        : "Every line is in a category the merchant sells through its agent.",
    ),
  );
  rules.push(ok("CATALOG.UNKNOWN_SKU", 1, 1, "All SKUs exist in the merchant catalogue."));
  rules.push(ok("CATALOG.BELOW_MOQ", 1, 1, "All quantities meet minimum order quantity."));
  rules.push(ok("INVENTORY.INSUFFICIENT", 1, 1, "Sufficient stock for every line."));
  rules.push(
    ok("INVENTORY.RESERVE", 1, profile.reserve_units ?? 0, "Every line leaves the safety stock intact."),
  );
  rules.push(ok("MARGIN.FLOOR_BREACH", 1, 1, "Every unit price is at or above the margin floor."));
  rules.push(ok("DISCOUNT.BPS_CAP", 1, 1, "Every discount is within the merchant ceiling."));

  /* 10. Drift. the gate's total is authoritative; the model's is only checked. */
  const totals = totalLines(lines);
  const computed = totals.total_cents;

  if (proposal.quoted_total_cents !== computed) {
    return deny(
      rules,
      bad(
        "DRIFT.AMOUNT_MISMATCH",
        proposal.quoted_total_cents,
        computed,
        `Agent quoted ${formatUSD(proposal.quoted_total_cents)} but the line items total ${formatUSD(computed)}. ` +
          `The quoted figure is discarded.`,
      ),
    );
  }
  rules.push(
    ok(
      "DRIFT.AMOUNT_MISMATCH",
      proposal.quoted_total_cents,
      computed,
      "Agent arithmetic matches the recomputed total.",
    ),
  );

  /* 10b. The merchant's own ceiling on a single order.
   *
   * Checked before the mandate's per-transaction cap, and deliberately so: this
   * is the seller declining the sale, which it may do for its own reasons and
   * before anyone asks what the buyer was authorised to spend. The two limits
   * are independent and either can bind first. */
  if (profile.max_order_cents !== undefined && computed > profile.max_order_cents) {
    return deny(
      rules,
      bad(
        "ORDER.VALUE_CAP",
        computed,
        profile.max_order_cents,
        `Cart totals ${formatUSD(computed)}; this merchant closes orders up to ${formatUSD(profile.max_order_cents)}.`,
      ),
    );
  }
  rules.push(
    ok(
      "ORDER.VALUE_CAP",
      computed,
      profile.max_order_cents ?? 0,
      "Within the largest order this merchant will close.",
    ),
  );

  /* 11. Per-transaction ceiling. */
  if (computed > mandate.max_per_txn_cents) {
    return deny(
      rules,
      bad(
        "MANDATE.PER_TXN_CAP",
        computed,
        mandate.max_per_txn_cents,
        `Cart totals ${formatUSD(computed)}; the per-transaction cap is ${formatUSD(mandate.max_per_txn_cents)}.`,
      ),
    );
  }
  rules.push(
    ok("MANDATE.PER_TXN_CAP", computed, mandate.max_per_txn_cents, "Within the per-transaction cap."),
  );

  /* 12. Envelope. The budget drawdown check. */
  const wouldConsume = ledger_state.consumed_cents + computed;
  if (wouldConsume > mandate.reserved_cents) {
    // consumed can exceed reserved if an envelope was reduced after a debit;
    // clamp so reporting a breach never itself throws.
    const remaining = cents(Math.max(0, mandate.reserved_cents - ledger_state.consumed_cents));
    return deny(
      rules,
      bad(
        "MANDATE.ENVELOPE_REMAINING",
        computed,
        remaining,
        `Cart totals ${formatUSD(computed)} but only ${formatUSD(remaining)} remains in the reserved envelope.`,
      ),
    );
  }
  rules.push(
    ok(
      "MANDATE.ENVELOPE_REMAINING",
      computed,
      Math.max(0, mandate.reserved_cents - ledger_state.consumed_cents),
      "Within the remaining reserved envelope.",
    ),
  );

  /* 13. Velocity. */
  if (ledger_state.txn_count + 1 > mandate.max_txn_count) {
    return deny(
      rules,
      bad(
        "MANDATE.VELOCITY",
        ledger_state.txn_count + 1,
        mandate.max_txn_count,
        `This would be debit ${ledger_state.txn_count + 1}; the mandate allows ${mandate.max_txn_count}.`,
      ),
    );
  }
  rules.push(
    ok(
      "MANDATE.VELOCITY",
      ledger_state.txn_count + 1,
      mandate.max_txn_count,
      "Within the permitted number of debits.",
    ),
  );

  /* 14. Replay. */
  const token = input.intent_token;
  if (token !== undefined) {
    if (input.spent_token_ids?.has(token.token_id) === true) {
      return deny(
        rules,
        bad("TOKEN.REPLAY", 1, 0, `Intent token ${token.token_id} has already been spent.`),
      );
    }
    if (Date.parse(token.expires_at) <= t) {
      return deny(
        rules,
        bad("TOKEN.REPLAY", t, Date.parse(token.expires_at), `Intent token ${token.token_id} has expired.`),
      );
    }
  }
  rules.push(ok("TOKEN.REPLAY", 0, 0, "Intent token is unspent and unexpired."));

  /* Build the cart the gate is willing to stand behind. */
  const cart: PricedCart = {
    cart_id: newId("cart"),
    merchant_id: proposal.merchant_id,
    lines,
    subtotal_cents: totals.subtotal_cents,
    discount_cents: totals.discount_cents,
    total_cents: computed,
  };

  /* 15. Step-up. Not a denial -- a requirement for a human to be in the loop. */
  const stepUp = stepUpReason(computed, mandate.requires_human_approval_above_cents, mandate.human_present);
  if (stepUp !== undefined) {
    return { outcome: "ALLOW_WITH_STEPUP", rules, computed_cents: computed, cart, step_up: stepUp };
  }

  return { outcome: "ALLOW", rules, computed_cents: computed, cart };
}

function stepUpReason(
  total: Cents,
  threshold: Cents,
  humanPresent: boolean,
): StepUpReason | undefined {
  if (total < threshold) return undefined;
  return humanPresent ? "ABOVE_HUMAN_APPROVAL_THRESHOLD" : "HUMAN_NOT_PRESENT_HIGH_VALUE";
}

/** Hash a priced cart, for binding an intent token to exactly this cart. */
export function cartHash(cart: PricedCart): string {
  return hashValue(cart);
}
