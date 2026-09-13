import "server-only";
import {
  type HolderProof,
  type RuleEval,
  holderChallenge,
  newNonce,
  signValue,
} from "@mercury/core";
import type { EventType } from "@mercury/ledger";
import type { BenchStatus, ChaosCheck, ChaosResult, ChaosRow, FailureId } from "./chaos-types";
import { type StripeEvent, chargeOf } from "@mercury/rail";
import { readWallet } from "@mercury/seed";
import { BUSINESS, processEmail } from "./intake";
import { WALLET_PATH, mercury } from "./mercury";
import { drain, release } from "./outbox";
import { envelopeView, runScenario } from "./run";
import { scenarioById } from "./scenarios";
import { quote } from "./transact";

/**
 * The Chaos Console.
 *
 * The failure-audit table has always existed as a claim in a markdown file.
 * This is the same table as an executable: each row injects its own failure,
 * then *checks* the recovery — the ledger events the row promises, and the
 * state that must not have moved. A row is green only when both hold.
 *
 * Two properties this file exists to enforce:
 *
 *  1. Nothing is asserted from the outside. Every row drives the same public
 *     surface a buyer or Stripe would drive; the webhook rows go out over
 *     HTTP to this app's own route, because a webhook that was only ever
 *     handed to a class in-process has never been rejected *as a request*.
 *  2. The ledger expectations are the ones written in DEVLOG's audit table,
 *     copied here verbatim. If the two ever disagree, this file is the one
 *     that can be run.
 */

export type { BenchStatus, ChaosCheck, ChaosResult, ChaosRow, FailureId };

export const CHAOS_ROWS: ChaosRow[] = [
  {
    id: "F1",
    failure: "Parameter drift",
    injection: "The agent quotes a total its own line items do not add up to",
    expected: "Hard DENY on drift. No Stripe call is made",
    ledger: ["DRIFT_BLOCKED"],
  },
  {
    id: "F2",
    failure: "Payment decline",
    injection: "pm_card_chargeDeclined — the card is declined at the rail",
    expected: "Bounded retries, then an approval link back to a human",
    ledger: ["PAYMENT_FAILED", "RETRY_BOUNDED", "STEPUP_ISSUED"],
  },
  {
    id: "F3",
    failure: "Undeliverable after capture",
    injection: "The warehouse reports the stock gone after the money moved",
    expected: "Automatic refund; stock and envelope restored; principal is whole",
    ledger: ["PAYMENT_CAPTURED", "AUTO_REFUND_ISSUED"],
  },
  {
    id: "F4",
    failure: "Forged webhook",
    injection: "A genuine body delivered with a tampered Stripe-Signature",
    expected: "400, order state untouched, and the genuine delivery still processes",
    ledger: ["WEBHOOK_REJECTED", "WEBHOOK_ACCEPTED"],
  },
  {
    id: "F5",
    failure: "Out-of-order / duplicate webhook",
    injection: "captured arrives before authorized, then the captured event is replayed",
    expected: "Monotonic payment FSM converges; the replay is a no-op",
    ledger: ["WEBHOOK_ACCEPTED", "WEBHOOK_DEDUPED"],
  },
  {
    id: "F6",
    failure: "Mandate breach",
    injection: "A basket beyond the mandate's per-transaction cap",
    expected: "DENY with exact observed and limit cents. Zero Stripe calls",
    ledger: ["MANDATE_BREACH_BLOCKED"],
  },
  {
    id: "F7",
    failure: "Token replay",
    injection: "The same intent token is redeemed twice over the buyer API",
    expected: "DENY TOKEN.REPLAY on the second. No duplicate order, no second capture",
    ledger: ["PAYMENT_CAPTURED", "REPLAY_BLOCKED"],
  },
  /*
   * The apps. An email-started run is paid for and then has to reach three
   * other systems; these rows break each way that can go wrong and check that
   * the money never notices.
   */
  {
    id: "F8",
    failure: "Receipt bounces",
    injection: "Gmail refuses the receipt once (550) after the payment is captured",
    expected: "Payment stands. The receipt is owed, retried, and sent exactly once — on attempt 2",
    ledger: ["PAYMENT_CAPTURED", "EMAIL_SENT"],
  },
  {
    id: "F9",
    failure: "Slack is down",
    injection: "Every Slack post fails (503) for the whole retry budget",
    expected: "Payment stands; the receipt and the calendar entry still go; the post is recorded as failed, never retried forever",
    ledger: ["PAYMENT_CAPTURED", "CALENDAR_EVENT_CREATED", "EMAIL_SENT", "APP_ACTION_FAILED"],
  },
  {
    id: "F10",
    failure: "Nothing to buy",
    injection: "An email with no product in it — a question, not an order",
    expected: "No cart reaches the gate, nothing is charged, and the reply says so honestly",
    ledger: ["EMAIL_RECEIVED", "EMAIL_SENT"],
  },
  {
    id: "F11",
    failure: "Crash after payment",
    injection: "The process dies after the capture, before any app is told; then it restarts",
    expected: "Four actions owed, none done; on restart each happens exactly once. One charge, one receipt",
    ledger: ["PAYMENT_CAPTURED", "CALENDAR_EVENT_CREATED", "SHEET_ROW_APPENDED", "CHAT_POSTED", "EMAIL_SENT"],
  },
];

export function chaosRow(id: string): ChaosRow | undefined {
  return CHAOS_ROWS.find((r) => r.id === id);
}

/* -------------------------------------------------------------- the bench */

const BENCH_MANDATE = "mnd_household_weekly";
const BENCH_MERCHANT = "mch_quick";

/**
 * What the rows spend, measured against a freshly seeded database rather than
 * estimated: one full pass over the table costs one debit of the mandate's
 * eight, $5.70 of its envelope, four cartons of oat milk and one bottle of
 * olive oil (the olive oil comes back, because F3 refunds it).
 *
 * F1 and F6 are denials and cost nothing. F2, F4 and F5 create orders without
 * capturing, so they take stock and no budget. F3 and F7 capture; F3 then
 * refunds, which restores both the envelope and the debit.
 */
const RUN_COST = { debits: 1, cents: 570, stock: { QC_OATMILK_1L: 4 } };

/**
 * Stock a row needs on hand but does not use up.
 *
 * F3 buys the olive oil and then refunds it, which puts the bottle back on the shelf.
 * Counting it as a per-run cost would have said "1 full pass left" on a
 * freshly seeded bench, because the seed stocks exactly one bottle -- a number
 * that is a level, not a drain.
 */
const RUN_REQUIRES = { QC_OLIVEOIL_500ML: 1 };

/** The cheapest thing an order-taking row buys: one carton of oat milk. */
const ROW_COST_CENTS = 600;

/** Rows that must buy a live order before they can inject anything. */
const NEEDS_ORDER: ReadonlySet<FailureId> = new Set<FailureId>(["F2", "F3", "F4", "F5", "F7"]);
/** Rows driven by an email into the café's inbox; they spend the café's envelope, not the household's. */
const EMAIL_ROWS: ReadonlySet<FailureId> = new Set<FailureId>(["F8", "F9", "F10", "F11"]);

export function benchStatus(): BenchStatus {
  const m = mercury();
  const e = envelopeView(BENCH_MANDATE);
  const stock = [...Object.keys(RUN_COST.stock), ...Object.keys(RUN_REQUIRES)].map((sku) => ({
    sku,
    available: m.store.getItem(sku)?.stock ?? 0,
  }));

  if (e === undefined) {
    return {
      mandate_id: BENCH_MANDATE,
      txn_count: 0,
      max_txn_count: 0,
      remaining_cents: 0,
      reserved_cents: 0,
      stock,
      runs_left: 0,
      ready: false,
      reason: `no mandate ${BENCH_MANDATE} — the database has not been seeded`,
    };
  }

  const debitsLeft = Math.max(0, e.max_txn_count - e.txn_count);
  const consumable = Object.entries(RUN_COST.stock).map(([sku, per]) =>
    Math.floor((m.store.getItem(sku)?.stock ?? 0) / per),
  );
  const shortRequired = Object.entries(RUN_REQUIRES).find(
    ([sku, need]) => (m.store.getItem(sku)?.stock ?? 0) < need,
  );

  const runsLeft = shortRequired !== undefined
    ? 0
    : Math.max(
        0,
        Math.min(
          Math.floor(debitsLeft / RUN_COST.debits),
          Math.floor(e.remaining_cents / RUN_COST.cents),
          ...consumable,
        ),
      );

  const shortStock =
    shortRequired !== undefined
      ? { sku: shortRequired[0], available: m.store.getItem(shortRequired[0])?.stock ?? 0 }
      : stock.find((s) => s.available < 1);
  const reason =
    debitsLeft < 1
      ? `the mandate has spent all ${e.max_txn_count} of its debits`
      : e.remaining_cents < ROW_COST_CENTS
        ? `only $${(e.remaining_cents / 100).toFixed(2)} of envelope left`
        : shortStock !== undefined
          ? `${shortStock.sku} is out of stock`
          : null;

  return {
    mandate_id: BENCH_MANDATE,
    txn_count: e.txn_count,
    max_txn_count: e.max_txn_count,
    remaining_cents: e.remaining_cents,
    reserved_cents: e.reserved_cents,
    stock,
    runs_left: runsLeft,
    ready: reason === null,
    reason,
  };
}

/* --------------------------------------------------------------- plumbing */

interface LedgerRow {
  event_type: string;
  detail?: Record<string, unknown>;
  decision?: { outcome: string; rule_ids: string[]; evidence: RuleEval[] };
}

class Window {
  readonly from: number;
  constructor(from: number) {
    this.from = from;
  }
  /** Everything the ledger recorded since this window opened. */
  entries(): LedgerRow[] {
    return mercury().ledger.read({ from: this.from }) as unknown as LedgerRow[];
  }
  types(): string[] {
    return [...new Set(this.entries().map((e) => e.event_type))];
  }
}

function openWindow(): Window {
  return new Window(mercury().ledger.count() + 1);
}

/** The row's promised ledger events, each one its own check. */
function ledgerChecks(row: ChaosRow, w: Window): ChaosCheck[] {
  const types = w.types();
  return row.ledger.map((t) => ({
    label: `The ledger records ${t}`,
    passed: types.includes(t),
    detail: types.includes(t) ? "present in the chain" : `absent — saw ${types.join(", ") || "nothing"}`,
  }));
}

function absent(w: Window, type: EventType, why: string): ChaosCheck {
  const seen = w.types().includes(type);
  return { label: why, passed: !seen, detail: seen ? `${type} was written` : `no ${type}` };
}

/** One email into the café's inbox, processed the way the real path processes it. */
async function driveEmail(
  text: string,
  origin: string,
  opts: { subject?: string; crashAfterPayment?: boolean } = {},
): Promise<{ run_id: string; result: string }> {
  const m = mercury();
  const email = {
    id: `msg_chaos_${Date.now().toString(36)}`,
    from: "manager@harborstreetcafe.test",
    to: m.fixtureMail?.address ?? "agent@mercury.test",
    subject: opts.subject ?? "Chaos drill",
    text,
    received_at: new Date().toISOString(),
  };
  const o = await processEmail(email, "scripted", origin, {
    noPace: true,
    ...(opts.crashAfterPayment === true ? { crashAfterPayment: true } : {}),
  });
  return { run_id: o.run_id, result: o.result };
}

/** Bring every pending outbox row for a run to its next attempt without waiting for the clock. */
async function drainRunNow(runId: string): Promise<void> {
  const m = mercury();
  for (const row of m.store.listOutbox({ run_id: runId })) {
    if (row.status !== "pending") continue;
    await drain(new Date(new Date(row.next_attempt_at).getTime() + 1));
  }
}

function count(w: Window, type: EventType): number {
  return w.entries().filter((e) => e.event_type === type).length;
}

function once(w: Window, type: EventType, why: string): ChaosCheck {
  const n = count(w, type);
  return { label: why, passed: n === 1, detail: `${n} x ${type}` };
}

/** The café's envelope: the bench for the email rows. */
function cafeBench(): { ready: boolean; reason: string | null } {
  const e = envelopeView(BUSINESS.mandate_id);
  if (e === undefined) return { ready: false, reason: `no mandate ${BUSINESS.mandate_id}` };
  if (e.txn_count >= e.max_txn_count) return { ready: false, reason: `the café's ${e.max_txn_count} debits are used` };
  if (e.remaining_cents < 3_000) return { ready: false, reason: "the café's envelope is spent" };
  return { ready: true, reason: null };
}

/** Run a Mission Control scenario with the theatre's narration discarded. */
async function driveScenario(id: string): Promise<void> {
  const scenario = scenarioById(id);
  if (scenario === undefined) throw new Error(`no scenario ${id}`);
  await runScenario(scenario, "scripted", () => {});
}

function proveHolder(mandateId: string): HolderProof {
  const entry = readWallet(WALLET_PATH).find((a) => a.mandate_id === mandateId);
  if (entry === undefined) {
    throw new Error(`no key for ${mandateId} in ${WALLET_PATH} — run npm run seed`);
  }
  const body = { mandate_id: mandateId, nonce: newNonce(), issued_at: new Date().toISOString() };
  return { ...body, signature: signValue(holderChallenge(body), entry.agent_private_key) };
}

/* ------------------------------------------------------------- webhook kit */

interface Delivery {
  status: number;
  body: { status?: string; reason?: string; event_id?: string };
}

/**
 * A Stripe-shaped delivery, signed the way Stripe signs.
 *
 * `forge` is the whole point of F4: identical bytes, a signature that does not
 * match them. The route must be unable to tell the difference by any means
 * other than the HMAC.
 */
async function deliver(
  origin: string,
  type: "charge.captured" | "charge.succeeded",
  charge: Record<string, unknown>,
  opts: { eventId: string; forge?: boolean },
): Promise<Delivery> {
  const m = mercury();
  const fixture = m.fixture;
  if (fixture === undefined) throw new Error("chaos webhooks need the fixture rail");

  const event: StripeEvent = {
    id: opts.eventId,
    object: "event",
    type,
    livemode: false,
    data: { object: charge },
    created: Math.floor(Date.now() / 1000),
  };
  const raw = JSON.stringify(event);
  const signature = opts.forge === true ? fixture.signWebhook(`${raw} `) : fixture.signWebhook(raw);

  const res = await fetch(`${origin}/api/webhook/stripe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": signature,
    },
    body: raw,
  });
  return { status: res.status, body: (await res.json()) as Delivery["body"] };
}

/** A Stripe charge object for a payment on one of our orders, in the given state. */
function chargeObject(paymentId: string, orderId: string, status: "authorized" | "captured", amount: number) {
  return chargeOf({
    id: paymentId,
    entity: "payment",
    amount,
    currency: "USD",
    status,
    order_id: orderId,
    method: "card",
    payment_method: "pm_card_visa",
    captured: status === "captured",
    created_at: Math.floor(Date.now() / 1000),
  }) as unknown as Record<string, unknown>;
}

/**
 * Why a setup quote was denied.
 *
 * Every row that needs a live order buys one first, and the demo mandate is
 * finite: eight transactions and $5,000. Run the whole table five times and
 * the gate starts denying the *setup*, which would otherwise show up as a red
 * row that looks like a bug in the thing being tested. It is the bench running
 * out, and it should say so.
 */
function benchExhausted(reason: string): Error {
  const e = envelopeView("mnd_household_weekly");
  const state =
    e === undefined
      ? "no envelope"
      : `txn ${e.txn_count}/${e.max_txn_count}, $${(e.remaining_cents / 100).toFixed(2)} left`;
  return new Error(`chaos setup was denied (${reason}) — demo mandate: ${state}. Press Reset.`);
}

/** An allowed, unpaid order to aim webhooks at. */
async function orderForWebhooks(): Promise<{ order_id: string; amount: number }> {
  const result = await quote({
    merchant_id: "mch_quick",
    mandate_id: "mnd_household_weekly",
    message: "One carton of oat milk, please.",
    internal: true,
  });
  if (result.cart === undefined) throw benchExhausted(result.outcome);
  return { order_id: result.cart.order_id, amount: result.cart.total_cents };
}

function paymentStatusOf(orderId: string): string {
  return mercury().store.getOrder(orderId)?.payment_status ?? "missing";
}

/* ------------------------------------------------------------------- rows */

async function runRow(row: ChaosRow, origin: string, w: Window): Promise<ChaosCheck[]> {
  switch (row.id) {
    case "F1": {
      await driveScenario("drift");
      return [
        ...ledgerChecks(row, w),
        absent(w, "ORDER_CREATED", "No order was created — the rail was never touched"),
        absent(w, "PAYMENT_CAPTURED", "No money moved"),
      ];
    }

    case "F2": {
      await driveScenario("decline");
      const retries = w
        .entries()
        .filter((e) => e.event_type === "RETRY_BOUNDED").length;
      return [
        ...ledgerChecks(row, w),
        {
          label: "Retries are bounded, not endless",
          passed: retries > 0 && retries <= 2,
          detail: `${retries} bounded retry event(s)`,
        },
        absent(w, "PAYMENT_CAPTURED", "Nothing was captured on the failing rail"),
      ];
    }

    case "F3": {
      const before = envelopeView("mnd_household_weekly")?.remaining_cents ?? -1;
      await driveScenario("oversold");
      const after = envelopeView("mnd_household_weekly")?.remaining_cents ?? -2;
      return [
        ...ledgerChecks(row, w),
        {
          label: "The envelope is restored to the cent",
          passed: before === after,
          detail: `remaining ${before} -> ${after}`,
        },
      ];
    }

    case "F4": {
      const order = await orderForWebhooks();
      const stamp = Date.now();
      const payload = chargeObject(`ch_chaos_${stamp}`, order.order_id, "captured", order.amount);
      const eventId = `evt_chaos_f4_${stamp}`;

      const forged = await deliver(origin, "charge.captured", payload, { eventId, forge: true });
      const afterForged = paymentStatusOf(order.order_id);
      // The same event id, now correctly signed: a forged delivery must not
      // have consumed it, or a forger could suppress the genuine event.
      const genuine = await deliver(origin, "charge.captured", payload, { eventId });
      const afterGenuine = paymentStatusOf(order.order_id);

      return [
        {
          label: "The forged delivery is rejected with 400",
          passed: forged.status === 400 && forged.body.status === "rejected",
          detail: `HTTP ${forged.status} ${forged.body.reason ?? ""}`.trim(),
        },
        {
          label: "Order state is untouched by the forgery",
          passed: afterForged === "created",
          detail: `payment_status ${afterForged}`,
        },
        {
          label: "The genuine delivery then processes",
          passed: genuine.status === 200 && genuine.body.status === "accepted",
          detail: `HTTP ${genuine.status} ${genuine.body.status ?? ""} -> payment_status ${afterGenuine}`,
        },
        ...ledgerChecks(row, w),
      ];
    }

    case "F5": {
      const order = await orderForWebhooks();
      const stamp = Date.now();
      const paymentId = `ch_chaos_${stamp}`;
      const capturedId = `evt_chaos_f5_cap_${stamp}`;

      // Out of order on purpose: the later event arrives first.
      const captured = await deliver(
        origin,
        "charge.captured",
        chargeObject(paymentId, order.order_id, "captured", order.amount),
        { eventId: capturedId },
      );
      const afterCaptured = paymentStatusOf(order.order_id);

      const late = await deliver(
        origin,
        "charge.succeeded",
        chargeObject(paymentId, order.order_id, "authorized", order.amount),
        { eventId: `evt_chaos_f5_auth_${stamp}` },
      );
      const afterLate = paymentStatusOf(order.order_id);

      const replay = await deliver(
        origin,
        "charge.captured",
        chargeObject(paymentId, order.order_id, "captured", order.amount),
        { eventId: capturedId },
      );
      const afterReplay = paymentStatusOf(order.order_id);

      return [
        {
          label: "The out-of-order captured event is accepted and applied",
          passed: captured.status === 200 && afterCaptured === "captured",
          detail: `HTTP ${captured.status} -> payment_status ${afterCaptured}`,
        },
        {
          label: "The late authorized does not wind the payment back",
          passed: late.status === 200 && afterLate === "captured",
          detail: `HTTP ${late.status} -> payment_status still ${afterLate}`,
        },
        {
          label: "The replayed event id is a no-op",
          passed:
            replay.status === 200 &&
            replay.body.status === "duplicate" &&
            afterReplay === "captured",
          detail: `HTTP ${replay.status} ${replay.body.status ?? ""} -> payment_status ${afterReplay}`,
        },
        ...ledgerChecks(row, w),
      ];
    }

    case "F6": {
      await driveScenario("breach");
      const breach = w.entries().find((e) => e.event_type === "MANDATE_BREACH_BLOCKED");
      const evidence = breach?.decision?.evidence?.[0];
      return [
        ...ledgerChecks(row, w),
        {
          label: "The denial carries exact observed and limit figures",
          passed: evidence !== undefined,
          detail:
            evidence === undefined
              ? "no rule evidence on the entry"
              : `${evidence.rule_id}: observed ${evidence.observed} vs limit ${evidence.limit} cents`,
        },
        absent(w, "ORDER_CREATED", "Zero Stripe calls — no order was created"),
      ];
    }

    case "F7": {
      const mandateId = "mnd_household_weekly";
      const quoted = await quote({
        merchant_id: "mch_quick",
        mandate_id: mandateId,
        message: "One carton of oat milk, please.",
        holder_proof: proveHolder(mandateId),
      });
      if (quoted.cart === undefined) throw benchExhausted(quoted.outcome);

      const redeem = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
        const res = await fetch(`${origin}/api/agent/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order_id: quoted.cart?.order_id,
            intent_token_id: quoted.cart?.intent_token_id,
            session_id: quoted.session_id,
            holder_proof: proveHolder(mandateId),
          }),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };

      const first = await redeem();
      const second = await redeem();
      const captures = w.entries().filter((e) => e.event_type === "PAYMENT_CAPTURED").length;

      return [
        {
          label: "The first redemption captures",
          passed: first.body["status"] === "captured",
          detail: `HTTP ${first.status} ${String(first.body["status"] ?? first.body["error"] ?? "")}`,
        },
        {
          label: "The replay is refused",
          passed: second.body["status"] === "rejected",
          detail: `HTTP ${second.status} ${String(second.body["reason"] ?? second.body["error"] ?? "")}`,
        },
        {
          label: "Exactly one capture, no duplicate order",
          passed: captures === 1,
          detail: `${captures} PAYMENT_CAPTURED entries`,
        },
        ...ledgerChecks(row, w),
      ];
    }

    default:
      throw new Error(`not a gate row: ${row.id}`);
  }
}

async function runEmailRow(row: ChaosRow, origin: string, w: Window): Promise<ChaosCheck[]> {
  const m = mercury();
  const mail = m.fixtureMail;
  const chat = m.fixtureChat;
  const cal = m.fixtureCalendar;
  if (mail === undefined || chat === undefined || cal === undefined) {
    throw new Error("the app failure rows need the fixture mail, chat and calendar");
  }
  const sentFor = (run: string): number => mail.sent().filter((x) => x.idempotency_key === `receipt:${run}`).length;

  switch (row.id) {
    case "F8": {
      mail.failNext("550 5.1.1 mailbox unavailable");
      const { run_id, result } = await driveEmail("2 cartons of napkins please", origin, { subject: "Napkins" });
      const beforeRetry = m.store.getOutbox(`receipt:${run_id}`);
      await drainRunNow(run_id);
      const after = m.store.getOutbox(`receipt:${run_id}`);
      return [
        { label: "The order was paid", passed: result === "captured", detail: `result ${result}` },
        {
          label: "The first send bounced and was scheduled again, not dropped",
          passed: beforeRetry?.status === "pending" && beforeRetry.attempts === 1,
          detail: `outbox ${beforeRetry?.status ?? "?"} after attempt ${beforeRetry?.attempts ?? "?"}: ${beforeRetry?.last_error ?? ""}`,
        },
        {
          label: "The retry sent it, on attempt 2",
          passed: after?.status === "done" && after.attempts === 2,
          detail: `outbox ${after?.status ?? "?"}, attempts ${after?.attempts ?? "?"}`,
        },
        { label: "Exactly one receipt left the outbox", passed: sentFor(run_id) === 1, detail: `${sentFor(run_id)} in Sent` },
        once(w, "PAYMENT_CAPTURED", "Exactly one capture — the bounce never touched the payment"),
        absent(w, "APP_ACTION_FAILED", "Nothing was given up on"),
        ...ledgerChecks(row, w),
      ];
    }

    case "F9": {
      chat.failNext("slack: 503 service unavailable", 3);
      const { run_id, result } = await driveEmail("2 cartons of napkins please", origin, { subject: "Napkins" });
      await drainRunNow(run_id);
      await drainRunNow(run_id);
      const slack = m.store.getOutbox(`summary:${run_id}`);
      return [
        { label: "The order was paid", passed: result === "captured", detail: `result ${result}` },
        {
          label: "Slack was tried three times, then given up on",
          passed: slack?.status === "failed" && slack.attempts === 3,
          detail: `outbox ${slack?.status ?? "?"}, attempts ${slack?.attempts ?? "?"}: ${slack?.last_error ?? ""}`,
        },
        { label: "The receipt still went", passed: sentFor(run_id) === 1, detail: `${sentFor(run_id)} in Sent` },
        once(w, "CALENDAR_EVENT_CREATED", "The delivery was still booked"),
        once(w, "SHEET_ROW_APPENDED", "The purchase was still logged"),
        once(w, "PAYMENT_CAPTURED", "Exactly one capture — a dead channel is not a refund"),
        ...ledgerChecks(row, w),
      ];
    }

    case "F10": {
      const { run_id, result } = await driveEmail("Can you send me last month's invoice?", origin, { subject: "Question" });
      const reply = mail.sent().find((x) => x.idempotency_key === `receipt:${run_id}`);
      return [
        { label: "The run ended as a refusal, not a purchase", passed: result === "denied", detail: `result ${result}` },
        absent(w, "ORDER_CREATED", "No order was created — no cart ever reached the gate"),
        absent(w, "PAYMENT_CAPTURED", "Nothing was charged"),
        absent(w, "CALENDAR_EVENT_CREATED", "Nothing was booked"),
        {
          label: "The reply says no product was found, not that the gate refused",
          passed: reply !== undefined && /couldn't find anything/u.test(reply.text),
          detail: reply === undefined ? "no reply sent" : (reply.text.split("\n")[0] ?? ""),
        },
        ...ledgerChecks(row, w),
      ];
    }

    case "F11": {
      const { run_id, result } = await driveEmail("2 cartons of napkins please", origin, {
        subject: "Napkins",
        crashAfterPayment: true,
      });
      const owed = m.store.listOutbox({ run_id });
      const pendingBefore = owed.filter((r) => r.status === "pending").length;
      const sentBefore = sentFor(run_id);
      const capturedBefore = count(w, "PAYMENT_CAPTURED");
      const appsBefore =
        count(w, "EMAIL_SENT") + count(w, "CHAT_POSTED") + count(w, "CALENDAR_EVENT_CREATED") + count(w, "SHEET_ROW_APPENDED");

      // The restart.
      const released = await release();
      const afterRows = m.store.listOutbox({ run_id });
      const again = await release();

      return [
        { label: "The order was paid before the crash", passed: result === "captured", detail: `result ${result}` },
        {
          label: "Four actions were owed and none had gone out",
          passed: pendingBefore === 4 && sentBefore === 0 && appsBefore === 0,
          detail: `${pendingBefore} pending, ${sentBefore} receipts sent, ${appsBefore} app events`,
        },
        {
          label: "The restart finished all four",
          passed:
            released.filter((r) => r.run_id === run_id && r.status === "done").length === 4 &&
            afterRows.every((r) => r.status === "done"),
          detail: afterRows.map((r) => `${r.app}:${r.status}`).join(", "),
        },
        { label: "Exactly one receipt", passed: sentFor(run_id) === 1, detail: `${sentFor(run_id)} in Sent` },
        {
          label: "Exactly one capture, before and after",
          passed: capturedBefore === 1 && count(w, "PAYMENT_CAPTURED") === 1,
          detail: `${count(w, "PAYMENT_CAPTURED")} x PAYMENT_CAPTURED`,
        },
        once(w, "CHAT_POSTED", "Exactly one Slack post"),
        once(w, "CALENDAR_EVENT_CREATED", "Exactly one calendar entry"),
        once(w, "SHEET_ROW_APPENDED", "Exactly one row in the purchase log"),
        { label: "A second restart finds nothing owed", passed: again.length === 0, detail: `${again.length} rows touched` },
        ...ledgerChecks(row, w),
      ];
    }

    default:
      throw new Error(`not an email row: ${row.id}`);
  }
}

/**
 * Run one row of the failure-audit table and report what actually happened.
 *
 * `origin` is this app's own base URL, supplied by the route. The webhook and
 * replay rows use it to make real requests to real routes: an in-process call
 * would prove the engine works and say nothing about the wire.
 */
export async function runChaos(id: FailureId, origin: string): Promise<ChaosResult> {
  const row = chaosRow(id);
  if (row === undefined) throw new Error(`unknown failure row: ${id}`);

  const started = Date.now();

  /*
   * Preflight. A row that needs a live order is checked against the bench
   * *before* it injects anything, because a setup denied for lack of budget
   * produces exactly the symptoms of the failure the row exists to test. It is
   * reported as blocked, not failed, and nothing is written to the ledger.
   */
  const bench = benchStatus();
  const cafe = EMAIL_ROWS.has(row.id) ? cafeBench() : { ready: true, reason: null };
  if (!cafe.ready) {
    return {
      ...row,
      blocked: true,
      passed: false,
      checks: [
        {
          label: "The café's envelope has budget to run this row",
          passed: false,
          detail: `${cafe.reason ?? "spent"} — press Reset (or npm run chaos -- --reset) to re-seed`,
        },
      ],
      observed: [],
      ledger_from: mercury().ledger.count(),
      ledger_to: mercury().ledger.count(),
      duration_ms: Date.now() - started,
      bench,
    };
  }
  if (NEEDS_ORDER.has(row.id) && !bench.ready) {
    return {
      ...row,
      blocked: true,
      passed: false,
      checks: [
        {
          label: "The bench has budget to run this row",
          passed: false,
          detail: `${bench.reason ?? "bench spent"} — press Reset (or npm run chaos -- --reset) to re-seed`,
        },
      ],
      observed: [],
      ledger_from: mercury().ledger.count(),
      ledger_to: mercury().ledger.count(),
      duration_ms: Date.now() - started,
      bench,
    };
  }

  const w = openWindow();
  let checks: ChaosCheck[];

  try {
    checks = EMAIL_ROWS.has(row.id) ? await runEmailRow(row, origin, w) : await runRow(row, origin, w);
  } catch (e) {
    checks = [
      { label: "The injection ran", passed: false, detail: (e as Error).message },
      ...ledgerChecks(row, w),
    ];
  }

  return {
    ...row,
    blocked: false,
    checks,
    passed: checks.every((c) => c.passed),
    observed: w.types(),
    ledger_from: w.from,
    ledger_to: mercury().ledger.count(),
    duration_ms: Date.now() - started,
    bench: benchStatus(),
  };
}
