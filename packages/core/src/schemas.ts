import { z } from "zod";
import type { Cents } from "./money.js";

/** Zod schema for a Cents value: a non-negative safe integer. */
export const zCents = z
  .number()
  .int("amount must be an integer number of cents")
  .nonnegative("amount must not be negative")
  .max(Number.MAX_SAFE_INTEGER)
  .transform((n) => n as Cents);

const zBps = z.number().int().min(0).max(1_000_000);
const zIso = z.string().datetime({ offset: true });

/* ------------------------------------------------------------------ verticals */

export const VERTICALS = ["quick_commerce", "b2b_procurement"] as const;
export const zVertical = z.enum(VERTICALS);
export type Vertical = z.infer<typeof zVertical>;

/* ------------------------------------------------------- merchant + catalogue */

export const LEVERS = ["bundle", "substitute", "bulk_tier", "credit_terms"] as const;
export const zLever = z.enum(LEVERS);
export type Lever = z.infer<typeof zLever>;

/**
 * The only per-vertical policy input the gate reads. If a vertical needs behaviour
 * The gate does not have, add a field here -- never a branch inside Gate.
 */
/**
 * Split settlement configuration -- Stripe Connect transfers, in Mercury's terms.
 *
 * A B2B basket is frequently multi-vendor: the buyer sees one cart and one
 * payment, and several suppliers have to be paid out of it. The platform's own
 * cut is a commission in bps, taken before the suppliers are paid, so a
 * supplier's share is never quietly reduced by a fee it did not agree to.
 */
export const zSettlement = z.object({
  mode: z.literal("route"),
  /** Platform commission, taken off the top. */
  commission_bps: zBps,
  /** Where the commission lands. */
  commission_account_id: z.string().min(1),
});
export type Settlement = z.infer<typeof zSettlement>;

export const zMerchantProfile = z.object({
  merchant_id: z.string().min(1),
  display_name: z.string().min(1),
  vertical: zVertical,
  /** Margin floor. Price may never fall below cost * (1 + min_margin_bps/10000). */
  min_margin_bps: zBps,
  /** Discount ceiling, measured against list price. */
  max_discount_bps: zBps,
  levers: z.array(zLever),
  category_taxonomy: z.array(z.string().min(1)),

  /*
   * The merchant's own limits on the shape of an order.
   *
   * Every one of these is optional, and absent means "no limit" -- an unset
   * control is not a control, and a profile written before these existed must
   * keep behaving exactly as it did. They are the merchant's side of the
   * bargain: the mandate caps say what the *buyer* may spend, and these say
   * what this merchant is willing to sell in one go, whatever the buyer's
   * budget allows.
   */

  /** Largest single order this merchant will close. Its own ceiling, not the buyer's. */
  max_order_cents: zCents.optional(),
  /** Most units, summed across every line, in one order. */
  max_order_units: z.number().int().positive().optional(),
  /** Most distinct lines in one order. Keeps a single cart pickable. */
  max_order_lines: z.number().int().positive().optional(),
  /** Safety stock: units of any SKU the agent may never sell into. */
  reserve_units: z.number().int().nonnegative().optional(),

  /**
   * The categories this merchant's agent may sell from.
   *
   * A SUBSET of `category_taxonomy`, and absent means the whole taxonomy. This
   * is the editable half of scope, and it only ever narrows: a merchant
   * withdrawing a category from its own agent is subtracting from a permission
   * it already holds. Widening lives in `category_taxonomy`, which no console
   * may touch -- see `zPolicyPatch`.
   */
  agent_categories: z.array(z.string().min(1)).optional(),

  /**
   * Split settlement, for verticals where the money does not all belong to one
   * party (Stripe Connect). The gate never reads this: how a captured dollar is
   * divided afterwards is not an authorisation question, and putting it in
   * front of the gate would be a category error.
   */
  settlement: zSettlement.optional(),
});
export type MerchantProfile = z.infer<typeof zMerchantProfile>;

/**
 * What a merchant may change about its own profile, from its own console.
 *
 * Deliberately narrower than `zMerchantProfile`. Identity (`merchant_id`,
 * `display_name`, `vertical`) is not policy, and `category_taxonomy` feeds
 * `SCOPE.CATEGORY_ALLOWLIST` -- a form that could widen a scope allowlist would
 * be a privilege escalation wearing a settings page. `commission_account_id` is
 * likewise off the table: where the platform's cut lands is not something the
 * merchant being charged gets to redirect.
 *
 * The bounds are tighter than `zBps` too. A discount ceiling above 100% is not
 * a policy, it is a typo, and the gate should not have to be the thing that
 * catches it.
 */
export const zPolicyPatch = z.object({
  merchant_id: z.string().min(1),
  /** Price may never fall below cost * (1 + min_margin_bps/10000). Up to 5x cost. */
  min_margin_bps: z.number().int().min(0).max(50_000).optional(),
  /** Discount off list. Cannot exceed the whole price. */
  max_discount_bps: z.number().int().min(0).max(10_000).optional(),
  levers: z.array(zLever).optional(),
  /** Route commission only. The account it lands in is not editable here. */
  commission_bps: z.number().int().min(0).max(10_000).optional(),

  /* The merchant's own order-shape limits. Zero or absent means no limit. */

  /** Largest order this merchant will close. Capped at $10 million -- above that it is a typo. */
  max_order_cents: z.number().int().min(0).max(1_000_000_000).optional(),
  /** Most units in one order. */
  max_order_units: z.number().int().min(0).max(100_000).optional(),
  /** Most distinct lines in one order. */
  max_order_lines: z.number().int().min(0).max(500).optional(),
  /** Safety stock held back from the agent on every SKU. */
  reserve_units: z.number().int().min(0).max(10_000).optional(),

  /**
   * Categories the agent may sell from.
   *
   * The schema cannot enforce the property that matters -- that this is a
   * subset of the merchant's own `category_taxonomy` -- because the taxonomy is
   * not in the patch. That check lives at the write site and is the reason this
   * field is safe to expose at all: it may only ever narrow. `category_taxonomy`
   * itself remains absent from this schema, permanently.
   */
  agent_categories: z.array(z.string().min(1)).optional(),
});
export type PolicyPatch = z.infer<typeof zPolicyPatch>;

export const zCatalogItem = z.object({
  sku: z.string().min(1),
  merchant_id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  gtin: z.string().optional(),
  unit: z.string().min(1),
  /** List price per unit. */
  list_cents: zCents,
  /** Landed cost per unit. Never exposed to the buyer agent. */
  cost_cents: zCents,
  stock: z.number().int().nonnegative(),
  /** Minimum order quantity (B2B). 1 for consumer goods. */
  moq: z.number().int().positive().default(1),
  /**
   * The connected account (`acct_...`) that gets paid for this line, when the seller
   * is not the merchant itself. Absent for own-inventory goods, which is why
   * quick-commerce settles as a single payment and nothing splits.
   *
   * Never published in the feed: who supplies a merchant is the merchant's
   * business, not the buyer's.
   */
  supplier_account_id: z.string().min(1).optional(),
});
export type CatalogItem = z.infer<typeof zCatalogItem>;

/* -------------------------------------------------------------- BudgetMandate */

/**
 * BudgetMandate -- the human-signed budget envelope.
 *
 * Shaped after the AP2 Intent Mandate and the pre-authorised budget hold a
 * card network offers (one block, multiple debits, unspent residual released). The limits travel
 * inside the artifact so any party can verify them independently of our
 * application logic.
 */
export const zBudgetMandate = z.object({
  mandate_id: z.string().min(1),
  principal_id: z.string().min(1),
  agent_id: z.string().min(1),
  /**
   * base64url raw Ed25519 public key of the agent this mandate delegates to.
   *
   * It lives *inside* the signed artifact deliberately: the human is not
   * authorising "an agent", they are authorising exactly this key. A caller
   * proves it holds the mandate by signing a challenge with the matching
   * private key, and that proof is verifiable by anyone holding the mandate --
   * no registry lookup, no shared secret, no trust in our own database.
   */
  agent_public_key: z.string().min(1),
  vertical: zVertical,

  /** Total reserved for the life of the envelope. */
  reserved_cents: zCents,
  /** Ceiling for any single transaction. */
  max_per_txn_cents: zCents,
  /** Maximum number of debits against this envelope. */
  max_txn_count: z.number().int().positive(),
  /** Spend at or above this needs a Human-Present step-up. */
  requires_human_approval_above_cents: zCents,

  scope: z.object({
    merchant_allowlist: z.array(z.string().min(1)).min(1),
    category_allowlist: z.array(z.string().min(1)).min(1),
  }),

  /** AP2 Human-Present / Human-Not-Present signal. */
  human_present: z.boolean(),

  not_before: zIso,
  expires_at: zIso,
  nonce: z.string().min(1),
});
export type BudgetMandate = z.infer<typeof zBudgetMandate>;

/** A mandate plus its detached Ed25519 signature and the key that signed it. */
export const zSignedBudgetMandate = z.object({
  mandate: zBudgetMandate,
  /** base64url detached signature over canonicalJson(mandate). */
  signature: z.string().min(1),
  /** base64url raw Ed25519 public key of the principal. */
  public_key: z.string().min(1),
});
export type SignedBudgetMandate = z.infer<typeof zSignedBudgetMandate>;

/* ------------------------------------------------------------- cart + pricing */

export const zCartLine = z.object({
  sku: z.string().min(1),
  qty: z.number().int().positive(),
  /** Unit price after negotiation. Always computed by the gate, never by the LLM. */
  unit_cents: zCents,
  /** Unit list price, retained so discount can be audited. */
  list_cents: zCents,
  line_total_cents: zCents,
});
export type CartLine = z.infer<typeof zCartLine>;

export const zPricedCart = z.object({
  cart_id: z.string().min(1),
  merchant_id: z.string().min(1),
  lines: z.array(zCartLine).min(1),
  subtotal_cents: zCents,
  discount_cents: zCents,
  total_cents: zCents,
});
export type PricedCart = z.infer<typeof zPricedCart>;

/** A priced cart bound to a mandate by hash, signed by the gate. */
export const zCartMandate = z.object({
  cart: zPricedCart,
  mandate_id: z.string().min(1),
  /** sha256 of canonicalJson(cart). */
  cart_hash: z.string().length(64),
  issued_at: zIso,
});
export type CartMandate = z.infer<typeof zCartMandate>;

/* --------------------------------------------------------------- intent token */

/**
 * Single-use, TTL-bounded authorisation for exactly one money action.
 * Mirrors the ACP Delegated Payment token: scoped, capped, expiring, and not
 * reusable.
 */
export const zIntentToken = z.object({
  token_id: z.string().min(1),
  mandate_id: z.string().min(1),
  cart_hash: z.string().length(64),
  amount_cents: zCents,
  nonce: z.string().min(1),
  issued_at: zIso,
  expires_at: zIso,
});
export type IntentToken = z.infer<typeof zIntentToken>;

/* ------------------------------------------------------------- holder proof */

/**
 * Proof that the caller holds the mandate it is spending against.
 *
 * A signed mandate proves the *envelope* is genuine. It does not prove the
 * caller is the agent the envelope was issued to -- without this, a mandate id
 * is a bearer token, and anyone who learns one can spend it.
 *
 * The signature covers the canonical JSON of {mandate_id, nonce, issued_at},
 * made with the private key matching `agent_public_key` in the mandate itself.
 */
export const zHolderProof = z.object({
  mandate_id: z.string().min(1),
  /** Single-use. A replayed nonce is refused even with a valid signature. */
  nonce: z.string().min(8),
  issued_at: zIso,
  /** base64url detached signature over canonicalJson({mandate_id, nonce, issued_at}). */
  signature: z.string().min(1),
});
export type HolderProof = z.infer<typeof zHolderProof>;

/** The bytes a holder proof signs. Kept here so both sides derive it identically. */
export function holderChallenge(proof: {
  mandate_id: string;
  nonce: string;
  issued_at: string;
}): { mandate_id: string; nonce: string; issued_at: string } {
  return { mandate_id: proof.mandate_id, nonce: proof.nonce, issued_at: proof.issued_at };
}

/* -------------------------------------------------------------- agent proposal */

/**
 * What the Revenue Agent proposes. `quoted_total_cents` is what the LLM SAYS the
 * total is -- it is never used to move money. The gate recomputes the total from
 * the line items and hard-denies on any mismatch (DRIFT.AMOUNT_MISMATCH).
 */
export const zProposal = z.object({
  merchant_id: z.string().min(1),
  lines: z
    .array(
      z.object({
        sku: z.string().min(1),
        qty: z.number().int().positive(),
        /** Unit price the agent is offering. */
        offer_unit_cents: zCents,
      }),
    )
    .min(1),
  /** The arithmetic the agent did itself. Checked, then discarded. */
  quoted_total_cents: zCents,
  rationale: z.string().max(2000),
});
export type Proposal = z.infer<typeof zProposal>;

/* ------------------------------------------------------------------ decisions */

export const RULE_IDS = [
  /** Merchant pulled the global kill switch. Checked first, always. */
  "CIRCUIT.FROZEN",
  /** Mandate signature does not verify against the registered principal key. */
  "MANDATE.SIGNATURE",
  /** now is outside [not_before, expires_at]. */
  "MANDATE.EXPIRY",
  "MANDATE.PER_TXN_CAP",
  "MANDATE.ENVELOPE_REMAINING",
  "MANDATE.VELOCITY",
  "SCOPE.MERCHANT_ALLOWLIST",
  "SCOPE.CATEGORY_ALLOWLIST",
  /**
   * The merchant withdrew this category from its own agent.
   *
   * Distinct from SCOPE.CATEGORY_ALLOWLIST, which is the *buyer's* scope: that
   * one says the human never authorised spending here, this one says the seller
   * declines to sell it through an agent. Different parties, different refusals.
   */
  "SCOPE.MERCHANT_CATEGORIES",
  /** Proposal references a SKU the merchant does not sell. */
  "CATALOG.UNKNOWN_SKU",
  /** Quantity below the SKU minimum order quantity (B2B). */
  "CATALOG.BELOW_MOQ",
  "INVENTORY.INSUFFICIENT",
  /** Filling this line would eat into the merchant's safety stock. */
  "INVENTORY.RESERVE",
  /** Cart total exceeds the largest order this merchant will close. */
  "ORDER.VALUE_CAP",
  /** Too many units in one order. */
  "ORDER.UNIT_CAP",
  /** Too many distinct lines in one order. */
  "ORDER.LINE_CAP",
  /** Offered unit price below cost * (1 + min_margin_bps). */
  "MARGIN.FLOOR_BREACH",
  /** Discount off list exceeds the merchant ceiling. */
  "DISCOUNT.BPS_CAP",
  /** The amount the LLM quoted differs from the amount the gate computed. */
  "DRIFT.AMOUNT_MISMATCH",
  /** Intent token already spent. */
  "TOKEN.REPLAY",
  /** Caller did not prove it holds the mandate it is spending. */
  "HOLDER.PROOF_MISSING",
  /** Proof does not verify against the agent key named in the signed mandate. */
  "HOLDER.SIGNATURE",
  /** Proof nonce has been used before. */
  "HOLDER.NONCE_REPLAY",
  /** Proof timestamp is outside the accepted clock skew. */
  "HOLDER.STALE",
] as const;
export const zRuleId = z.enum(RULE_IDS);
export type RuleId = z.infer<typeof zRuleId>;

export const zRuleEval = z.object({
  rule_id: zRuleId,
  passed: z.boolean(),
  /** Observed value, in cents or basis points depending on the rule. */
  observed: z.number(),
  /** The limit the observation was tested against. */
  limit: z.number(),
  /** Deterministic template text. Never generated by a model. */
  message: z.string(),
});
export type RuleEval = z.infer<typeof zRuleEval>;

export const STEP_UP_REASONS = [
  "ABOVE_HUMAN_APPROVAL_THRESHOLD",
  "HUMAN_NOT_PRESENT_HIGH_VALUE",
] as const;
export const zStepUpReason = z.enum(STEP_UP_REASONS);
export type StepUpReason = z.infer<typeof zStepUpReason>;

export type Decision =
  | { outcome: "ALLOW"; rules: RuleEval[]; computed_cents: Cents; cart: PricedCart }
  | {
      outcome: "ALLOW_WITH_STEPUP";
      rules: RuleEval[];
      computed_cents: Cents;
      cart: PricedCart;
      step_up: StepUpReason;
    }
  | { outcome: "DENY"; rules: RuleEval[]; violation: RuleEval };

export type DecisionOutcome = Decision["outcome"];

/* ---------------------------------------------------------------- environment */

export const zEnv = z.object({
  RAIL_MODE: z.enum(["fixture", "live"]).default("fixture"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  MAIL_MODE: z.enum(["fixture", "gmail"]).default("fixture"),
  GMAIL_USER: z.string().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  MAIL_POLL_SECONDS: z.coerce.number().int().min(5).default(15),
  CHAT_MODE: z.enum(["fixture", "slack"]).default("fixture"),
  SLACK_WEBHOOK_URL: z.string().optional(),
  CALENDAR_MODE: z.enum(["fixture", "google"]).default("fixture"),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().optional(),
  SHEETS_MODE: z.enum(["fixture", "google"]).default("fixture"),
  GOOGLE_SHEET_ID: z.string().optional(),
  GOOGLE_SHEET_TAB: z.string().default("Purchases"),
  ANTHROPIC_API_KEY: z.string().optional(),
  MERCURY_MODEL: z.string().default("claude-opus-5"),
  MERCURY_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  MERCURY_DB: z.string().default("./mercury.db"),
});
export type Env = z.infer<typeof zEnv>;
