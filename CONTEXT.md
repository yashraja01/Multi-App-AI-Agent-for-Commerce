# CONTEXT — Mercury

> Read this file first in any new session. It is the project's stable truth.
> Volatile state (what's done, what's next, decisions log) lives in DEVLOG.md.

## 1. What we are building

Mercury is **a purchasing agent for a small business that cannot overspend**,
and the merchant-side rail it buys from. You email it what the business needs.
It negotiates with the supplier's own AI agent, a deterministic policy gate
re-prices the cart and checks the budget the owner signed, a payment provider
settles it, the delivery lands on the calendar, the receipt lands in the inbox
— and every step, in every app, is one line in a tamper-evident ledger.

One line: *Two AI agents negotiate. A deterministic gate decides whether a
single cent may move. Stripe settles it. A hash chain proves it — across every
app the agent touched.*

| Name | Role |
|---|---|
| Mercury | The product (Roman god of commerce and messengers — from *merx*, the root of *merchant*) |
| the Gate | Deterministic policy gate. Pure function, no I/O, no LLM |
| the Ledger | Append-only, hash-chained audit trail |

Architecture in two words: **a gate, and a witness.**

This is a fork of the Mercury built for the Razorpay Buildathon (see the parent
directory), re-based for a global audience and extended to span several
external apps for a multi-app agent hackathon. What carried over unchanged is
the thesis and the core: the negotiation, the gate, the ledger, the human
step-up, the failure drills. What changed is everything around them.

## 2. Goals

1. **Useful across the apps a business already uses** — one email in; payment,
   calendar, purchase log, chat and receipt out. Gmail, Stripe, Google Calendar,
   Google Sheets, Slack.
2. **Grow merchant revenue** — a merchant-side Revenue Agent negotiates bundles
   and pricing to lift basket value, inside hard margin bounds.
3. **Every money action explainable, bounded, gated** — signed mandates, a pure
   policy gate, human step-up, instant freeze.
4. **Prove it** — an audit trail an outside party can independently verify,
   covering every external-app action as well as every cent.
5. **Reliable, and shown to be** — every scenario runs end to end, offline, in
   one command; every engineered failure is injected and checked live; the
   limitations are written down.

## 3. Non-goals

- Not a payment processor. Stripe does settlement; we do authorization.
- Not a conformance implementation. We implement AP2 / ACP / UCP **shapes**
  faithfully; we do not claim certification.
- No production keys, ever. Stripe test mode only (`sk_test_...`).
- Not a general email or calendar client. Each app integration does exactly the
  one job the story needs and nothing else.

## 4. Architecture

```
Buyer side          Gmail (an email from the business)  |  external Claude (MCP)  |  in-app buyer agent
                    carries: BudgetMandate (human-signed) + intent token
                                    |
                    MCP (stdio)  ·  A2A Agent Card  ·  SSE
                                    v
  +-------------------------------------------------------------+
  | MERCURY GATEWAY — Next.js route handlers                    |
  |                                                             |
  |  @mercury/core     types · Cents · Zod · canonical JSON     |
  |  @mercury/agent    Revenue Agent + Engine — PROPOSES ONLY   |
  |  @mercury/gate     ## THE GATE ## pure · deterministic · NO LLM
  |  @mercury/rail     PaymentPort -> FixtureRail | StripeRail  |
  |  @mercury/store    catalogue · mandates · tokens · orders   |
  |  @mercury/ledger   ## THE LEDGER ## append-only sha256 chain|
  +-------------------------------------------------------------+
              |                       |                    |
      SQLite (WAL)           Stripe TEST (sk_test_)   Gmail · Calendar · Slack
                                                      (each: Fixture | Live)
```

**The invariant that defines the system:** the LLM proposes; the gate disposes.
The agent never holds a key, never calls the payment provider, and the number it
says is discarded — the gate recomputes the total from signed catalogue line
items and creates the order from *its* figure.

**The second invariant, for the apps:** the gate stands in front of money, and
only money. An email that bounces or a calendar API that is down is recorded,
retried within a bound, and can never block or unblock a payment.

## 5. Two verticals, one gate

The rail is vertical-agnostic. **Only data and prompts differ.** If a vertical
ever needs a change inside the gate, that is a design bug — add a
`MerchantProfile` field instead.

| | B2C quick-commerce | B2B procurement |
|---|---|---|
| Merchant | **Corner Fresh Market** — neighbourhood grocer, same-hour delivery | **Harbor Wholesale Supply** — food-service distributor |
| Buyer | A household's shopping agent | A café's purchasing agent (the demo's hero) |
| Mandate archetype | Recurring weekly envelope, Human-**Not**-Present | Large single-deal envelope, Human-Present step-up |
| Settlement | Single payment, own inventory | **Split**: one capture divided across supplier accounts |
| Revenue levers | Bundling, substitution, basket-building | Bulk tiers, MOQ, credit terms, multi-vendor basket |
| Catalogue seed | `QUICK_COMMERCE` in `packages/seed/src/catalogs.ts` | `B2B_PROCUREMENT`, same file |
| Agent persona | `prompts/persona.quick-commerce.md` | `prompts/persona.b2b.md` |
| Mandate seed | `mnd_household_weekly` — $50 envelope, $20 per order, ask above $15 | `mnd_restaurant_restock` — $3,000 envelope, $1,500 per order, ask above $600 |
| Shared | **gate · ledger · store · rail · engine · tool schemas · FSM · UI** | <- identical |

`MerchantProfile` is the only per-vertical policy input the gate reads:

```ts
type MerchantProfile = {
  merchant_id: string
  min_margin_bps: number          // margin floor
  max_discount_bps: number        // discount ceiling
  levers: ("bundle"|"substitute"|"bulk_tier"|"credit_terms")[]
  category_taxonomy: string[]

  // The merchant's own limits on the shape of an order. Absent means no limit.
  max_order_cents?: number        // ORDER.VALUE_CAP
  max_order_units?: number        // ORDER.UNIT_CAP
  max_order_lines?: number        // ORDER.LINE_CAP
  reserve_units?: number          // INVENTORY.RESERVE
  agent_categories?: string[]     // SCOPE.MERCHANT_CATEGORIES; ⊆ category_taxonomy

  settlement?: {                  // Split settlement. The gate never reads this.
    mode: "route"
    commission_bps: number
    commission_account_id: string
  }
}
```

The five order-shape fields are the **merchant's** side of the bargain, and they
sit beside the mandate's caps rather than replacing them: the mandate says what
the buyer was authorised to spend, these say what this merchant is willing to
sell in one go. Either can bind first, and the rule list names which did.
`ORDER.VALUE_CAP` is checked *before* `MANDATE.PER_TXN_CAP` — a seller declining
a sale does not depend on what the buyer could afford.

`agent_categories` may **only ever narrow**. Widening lives in
`category_taxonomy`, which no console may touch. `settlement` is the one field
the gate ignores on purpose: how a captured dollar is divided afterwards is not
an authorisation question.

## 6. Running it

```bash
npm install
npm run seed        # fresh DB + mandates + buyer-wallet.json
npm run dev         # Mission Control + merchant console on :3000
```

| Command | Does |
|---|---|
| `npm run seed` | Wipes and re-seeds `mercury.db`; mints `buyer-wallet.json` |
| `npm run dev` | Mission Control, the merchant console and the buyer API on :3000 |
| `npm run demo` | The whole path on a terminal, no browser, no key |
| `npm run mcp:smoke` | Drives the MCP server over real stdio JSON-RPC (needs `npm run dev`) |
| `npm run eval` | **The Reliability Report**: re-seeds, then every bench scenario against its expected outcome, four emails through the inbox, the eleven failure drills, and a chain verify — 24 checks, ~2s, non-zero exit on any red (needs `npm run dev`) |
| `npm run chaos` | Runs the failure-audit table F1-F11 and prints what it verified (needs `npm run dev`) |
| `npm run chaos -- --reset` | Same, but re-seeds the demo bench first |
| `npm run conformance` | Checks the Agent Card and every feed against the shape they claim, and that no public document leaks cost, the margin floor or a supplier account (needs `npm run dev`) |
| `npm test` | 271 tests. No API key, no network, no spend |
| `npm run verify` | Re-walks the ledger chain independently |
| `npm run build` | Packages, then `scripts/`, then the Next app |

**Repo map**

```
packages/core    Cents, canonical JSON, Ed25519, schemas   (imports nothing)
packages/ledger  hash-chained ledger
packages/store   mutable working state (SQLite)
packages/gate    the gate: one pure evaluate()
packages/rail    PaymentPort -> FixtureRail | StripeRail
packages/seed    catalogue + mandate fixtures, buyer wallet
packages/agent   negotiators, levers, lever tools, prompts, the Engine
apps/web         Mission Control + merchant console + buyer API + Card + feed
apps/mcp         MCP stdio server (thin client of apps/web)
prompts/         system.core.md + three personas
scripts/         seed, demo, verify-chain, mcp-smoke, chaos, conformance
```

Paths in the app are anchored to the nearest `tsconfig.base.json`, not
`process.cwd()` — `next dev` runs from `apps/web`, and a bare relative path
there silently creates a second database.

## 7. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Repo | **npm workspaces** | npm ships with Node — zero install friction for judges |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` | Deterministic type safety |
| App | Next.js 15 (App Router) — one runnable app | `npm run dev` starts everything; raw body via `await req.text()` for webhook HMAC |
| UI | Tailwind v4, hand-built components | ~8 elements; a component library would be a generator and a tree for nothing |
| UI transport | SSE from a Node-runtime route | A verdict that arrives already decided is a report, not a demonstration |
| DB | SQLite (WAL) via `node:sqlite` | Zero install, zero deps; ships seeded. `BEGIN IMMEDIATE` gives real inventory locking |
| LLM | `@anthropic-ai/sdk`, `claude-opus-5` | Adaptive thinking, `output_config.effort: "high"` |
| LLM safety | `betaZodTool` + `strict: true` tools | Guarantees `tool_use.input` validates exactly |
| LLM cost | `cache_control: ephemeral` on frozen prompt + catalogue | Volatile turn state goes after the breakpoint |
| Crypto | `node:crypto` Ed25519 | Native, zero deps |
| Validation | Zod | One schema language: API, LLM output, env |
| Tests | Vitest + fast-check | Property-test the gate |

## 8. Module contracts

| Module | Owns | Must never |
|---|---|---|
| `core` | Branded `Cents`, IDs, Zod schemas, canonical JSON, sha256 | Import any other module |
| `gate` | `evaluate()`, pricing/margin, drift detection, FSM | Do I/O, call an LLM, or import `rail` |
| `ledger` | Append + verify hash chain | Mutate or delete a row |
| `rail` | `PaymentPort` impls, HMAC verify, webhook parsing | Decide anything policy-related |
| `store` | Mutable working state: catalogue, mandates, tokens, orders | Touch the ledger chain |
| `seed` | Catalogue + mandate fixtures for both verticals | Contain logic of any kind |
| `agent` | Negotiation, revenue levers, tool schemas, prompts, the Engine | Compute a final price or touch a key |
| `web` | Mission Control, the merchant console, the buyer-facing API, feed and Agent Card | Decide anything about *money*. The merchant console sets policy; the gate still applies it |
| `mcp` | Buyer transport over stdio | Accept a price, or hold state of its own |

## 9. The negotiator port

`agent` exposes the negotiator behind an interface, for the same reason `rail`
does:

```ts
interface Negotiator {
  readonly mode: "llm" | "scripted"
  negotiate(turn: NegotiationTurn): Promise<NegotiationResult>
}
```

- **`ScriptedRevenueAgent`** — deterministic, no API key, no network, no spend.
  The default in tests and in `npm run demo`. It calls the *same* tool
  implementations and submits through the *same* gate; only the judgement is
  substituted.
- **`LlmRevenueAgent`** — `claude-opus-5`, adaptive thinking, `strict: true`
  tools, cached `tools -> system` prefix.

A negotiator's entire reach into the system is one function:

```ts
submit: (proposal: Proposal) => Promise<GateFeedback>
```

No store, no ledger, no rail, no key. `gateVia(engine, ...)` supplies it.

## 10. The revenue levers

`MerchantProfile.levers` is what a merchant permits. A lever a profile does not
list is never pulled, which is how one implementation serves both verticals.

| Lever | Mechanism | Guard |
|---|---|---|
| `bulk_tier` | Quantity ladder: deeper discount at 5 / 10 / 25 / 50 units | Clamps to the margin floor; deeper tiers simply stop |
| `bundle` | Add-on from a *different* category than the basket anchor | Capped at 40% of basket value, and only added when the buyer invites it |
| `substitute` | Nearest stocked equivalent, same category | Never crosses category; silent if the line can be filled |

Every lever clamps to `lowestLegalUnit` itself, so it cannot produce a price the
gate would have to catch. The gate still checks — that is what makes the clamp
safe to trust rather than merely polite.

**Both agents reach the same levers.** The scripted agent calls these functions
directly; the model reaches them as three tools — `bulk_tier_quote`,
`suggest_bundle`, `find_substitute` — that call the same implementations.

**Uplift is measured, not asserted.** `BasketValue` records what the buyer asked
for versus what the gate approved, and it goes into the ledger beside the
decision. **Attribution is earned, not claimed**: a lever is credited only when
its effect is visible in the cart the gate *approved*. Under-counting is the
only safe direction for a number a merchant reads as revenue.

**Bundling requires consent.** `bundle` returns a *suggestion* unless the
buyer's message opens the door; only then does it enter the cart.

## 11. The buyer surface

An external agent reaches the merchant through three things, in this order:

| Surface | Path | Carries |
|---|---|---|
| A2A Agent Card | `/.well-known/agent.json` | Who this is, what it sells, how authority works, **what it will refuse** |
| Product feed | `/api/feed/{merchant_id}` | UCP/ACP-shaped: stable SKUs, cents, live stock, MOQ |
| Transaction API | `/api/agent/{quote,pay,mandate,audit}` | The negotiation itself |

`apps/mcp` wraps that API as MCP stdio tools. It is a **thin client of the
gateway**, not a second engine: one store, one ledger, one rail, so a purchase
made from Claude Desktop appears live in Mission Control.

**Every buyer-facing call is signed.** The mandate names the delegated agent's
Ed25519 public key *inside the signed artifact*, so the human authorises exactly
one key. A caller proves it holds the mandate by signing `{mandate_id, nonce,
issued_at}` with the matching private key; the gate checks it as `HOLDER.*`
rules before it looks at the cart. Without this a mandate id is a bearer token.

**No buyer-facing surface accepts a price.** Not a total, not a unit price, not
a discount. A buyer sends a sentence; the merchant's agent proposes; the gate
prices.

## 12. The rail port

`rail` exposes one interface with two implementations, chosen by `RAIL_MODE`.
The entity types are Mercury's own (`RailOrder`, `RailPayment`, `RailRefund`,
`RailTransfer`, `RailPaymentLink`); `StripeRail` maps Stripe's PaymentIntent /
Charge / Refund / Transfer / Payment Link onto them, so nothing above the port
knows which provider it is talking to.

```ts
interface PaymentPort {
  createOrder(o: OrderInput): Promise<RailOrder>              // PaymentIntent, capture_method=manual
  attemptPayment(orderId, paymentMethod): Promise<PaymentAttempt>  // confirm; a decline is a result, not a throw
  capturePayment(paymentId, amount: Cents): Promise<RailPayment>   // the explicit second step
  refund(paymentId, amount: Cents): Promise<RailRefund>
  createTransfers(paymentId, legs): Promise<RailTransfer[]>   // Connect transfers, split settlement
  createPaymentLink(l: LinkInput): Promise<RailPaymentLink>   // hosted page for the human step-up
  verifyWebhookSignature(rawBody, stripeSignatureHeader): { ok } | { ok: false, reason }
}
```

- **`FixtureRail`** (`RAIL_MODE=fixture`, default) — recorded response shapes,
  deterministic ids (`pi_FIX…`, `ch_FIX…`), Stripe's test payment methods
  (`pm_card_visa` succeeds, `pm_card_chargeDeclined` declines). Runs offline. All
  tests and all seven failure drills work here with no network and no tunnel.
- **`StripeRail`** (`RAIL_MODE=live`) — the real API over `fetch`, `sk_test_…`
  only (it refuses a live key). Same interface.

**Authorise, then capture.** `createOrder` opens a manual-capture intent,
`attemptPayment` confirms it, and only `capturePayment` — called with the
amount *the gate computed* — moves money. The seam is real in both rails, so
"verified, then captured" is a property of the code path, not a story.

**Webhooks are Stripe-shaped in both modes.** The fixture emits real Stripe
event bodies (`charge.succeeded`, `charge.captured`, `charge.refunded`,
`payment_intent.succeeded`, `transfer.created`) and signs them the way Stripe
does — `Stripe-Signature: t=…,v1=…` over `${t}.${body}`, with a five-minute
tolerance window and constant-time comparison. The route verifies the raw
body before parsing, dedupes on the `evt_…` id inside the body, and advances
payment state monotonically so out-of-order deliveries cannot wind it back.
The forged- and duplicate-webhook drills fire real HTTP requests at
`/api/webhook/stripe`.

**Split settlement.** A wholesale basket is one payment and several sellers.
After capture the engine divides the money by what each supplier actually sold —
largest remainder, so the legs sum to the capture exactly — and takes the
platform commission off the top. A transfer that fails does **not** unwind the
capture; it is recorded and left for an operator. Live transfers need Stripe
Connect accounts (`acct_…`) that test mode does not have out of the box, so this
leg is fixture-verified only.

Every test runs against `FixtureRail`. `StripeRail` has transport tests over a
fake `fetch` (manual capture, metadata, a 402 decline handled as a failed
attempt) and has not yet been run against a real test key.

## 13. The app ports

Every external app the agent touches goes through the same pattern as the rail:
one interface, a **fixture** that runs offline with no credentials, a **live**
implementation behind one env var, and a ledger event for every action.

| Port | Fixture | Live | Ledger events | Role in the story |
|---|---|---|---|---|
| `MailPort` | in-memory inbox + outbox | Gmail (IMAP in, SMTP out, app password) | `EMAIL_RECEIVED`, `EMAIL_SENT` | How you talk to it |
| — | — | — | `APP_ACTION_FAILED` | Any app action that failed after its retries. Recorded; never touches money |
| `PaymentPort` | `FixtureRail` | `StripeRail` | `ORDER_CREATED`, `PAYMENT_CAPTURED`, … | How it pays |
| `CalendarPort` | in-memory calendar | Google Calendar (service account, hand-rolled RS256 JWT) | `CALENDAR_EVENT_CREATED` | What happens next: a delivery window, only for a paid order |
| `SheetPort` | in-memory rows | Google Sheets (same service account, `values:append`) | `SHEET_ROW_APPENDED` | The owner's own copy: one row per paid order, append-only |
| `ChatPort` | in-memory channel | Slack (incoming webhook) | `CHAT_POSTED` | How it asks permission (approval request on step-up) and reports (one-line summary) |

**Every app action goes through `appAction()`** (`apps/web/lib/apps.ts`):
success is the named ledger event, failure is `APP_ACTION_FAILED`, both are
narrated on the run bus, and nothing is thrown past it. The intake calls the
apps in the order calendar → sheet → chat → mail, each independently. **The inbox
belongs to one business** (`BUSINESS` in `intake.ts`: Harbor Street Café buying
from Harbor Wholesale under `mnd_restaurant_restock`); the sender picks nothing
but the goods.

**Every app action goes through the outbox** (`apps/web/lib/outbox.ts`). The
action is written as a row in the *same SQLite file as the order* — keyed by an
idempotency key such as `receipt:<run_id>` — before it is attempted. Attempts
are bounded (3, backing off 2s then 5s); exhaustion is `APP_ACTION_FAILED`. On
boot, `mercury()` drains whatever the last process still owed. A process that
dies after the payment and before the receipt therefore finishes the run on
restart — without a second email, a second calendar entry, or a second charge.
Three layers make that true: the outbox row (survives a restart), the port's
in-process dedupe (survives a retry), and the idempotency key on the wire
(survives the provider retrying us). `crash_after_payment` on the intake route
reproduces the crash; `POST /api/ops/outbox {"action":"release"}` is the
restart.

## 14. Two screens

The app has two seats at the same system, switched from the header nav.

| Screen | Seat | Answers |
|---|---|---|
| `/` Mission Control | the observer | *What did the agent do across my apps, did the gate decide correctly, and can I check?* |
| `/merchant` | the merchant | *What did my agent earn me, and what is it allowed to do?* |

### Mission Control

| Panel | Shows |
|---|---|
| One email, five apps | The eight stations of a run lighting up in order — inbox, negotiation, gate, payment, calendar, purchase log, chat, receipt — each with a timestamp and a one-line result; the composer beside it |
| Negotiation theatre | Buyer and merchant turns, each offer, each verdict, settlement |
| The gate | **Agent quoted vs gate computed**, then every rule with observed and limit |
| The ledger | Each entry with `prev_hash <- hash`, and a live `verify` |
| Tested, not trusted | The eleven failure drills (F1–F11), each injected then checked, run against the live gate, ledger, rail and apps; the chain re-verified at the end |

Controls: the scenarios, a scripted/Claude agent switch, a freeze kill switch,
and reset.

### The merchant console

The only screen in the app that *decides* anything. Earnings (what the agent
earned over a plain price list, summed from `BASKET_VALUED` entries in the
chain), editable instructions (each one a gate rule, each change appended to the
ledger as `POLICY_CHANGED`), recent orders, and per-mandate remaining authority.
Every figure is in the unit a shopkeeper thinks in — percent, dollars, units —
never basis points.

**No control here is advisory.** Set the line cap to 1 and the very next
negotiation is denied on `ORDER.LINE_CAP`. The margin floor is deliberately not
editable from the console.

## 15. Money rule

All money is **integer cents**, branded type `Cents`. No floats anywhere. Zod
rejects non-integers at every boundary. Stripe amounts are minor units by
definition.

## 16. Constraints

- Stripe **test mode only**. Test payment methods: `pm_card_visa` succeeds,
  `pm_card_chargeDeclined` declines.
- Webhook signatures are verified on the raw body before parsing. Dedupe on the
  provider's event id. Handle out-of-order delivery.
- Secrets live only in `.env` (git-ignored). `.env.example` is committed.

## 17. Protocol alignment

| Ecosystem primitive | Our implementation |
|---|---|
| AP2 Intent / Cart / Payment Mandates | `BudgetMandate` (human-signed) -> `CartMandate` (gate-signed) -> `intent_token` (single-use) |
| AP2 Human-Present / Not-Present | Explicit field; above-threshold spend forces Human-Present step-up |
| ACP Delegated Payment (single-use, capped, expiring) | `intent_token`: nonce'd, TTL'd, consumed in the same DB transaction as the order |
| A2A Agent Card discovery | `/.well-known/agent.json` (live) |
| UCP / ACP capability + product feed | `/api/feed/{merchant_id}` (live) |
| Instant revocation | Global freeze flag -> `CIRCUIT.FROZEN` |

## 18. Glossary

- **the Gate** — the deterministic policy gate. Pure function, no I/O, no LLM.
- **the Ledger** — the append-only, hash-chained audit trail.
- **BudgetMandate** — human-signed budget envelope: one block, many debits,
  unspent residual released on close.
- **CartMandate** — gate-signed, hash-bound priced cart.
- **intent_token** — single-use, TTL'd authorization for exactly one money action.
- **Gate decision** — `ALLOW` | `ALLOW_WITH_STEPUP` | `DENY`, plus `RuleEval[]`.
- **Drift** — LLM-quoted amount != gate-computed amount. Always a hard `DENY`.
- **Outbox** — the idempotent, bounded-retry queue every external-app action
  passes through.
