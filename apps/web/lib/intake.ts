import "server-only";
import type { AppendedRow, CreatedEvent, InboundEmail, PostedMessage, SentEmail } from "@mercury/apps";
import { appAction } from "./apps";
import { holdRun } from "./outbox";
import { newId } from "@mercury/core";
import { bus } from "./bus";
import { dollars } from "./format";
import { mercury } from "./mercury";
import { runScenario } from "./run";
import type { Scenario } from "./scenarios";
import type { CartLine, TheatreEvent } from "./types";

type NamedLine = CartLine & { title: string };

/**
 * The intake: an email becomes a purchase.
 *
 * This inbox belongs to one business. Whoever writes to it is asking the
 * business's purchasing agent to buy something, under the budget the owner
 * signed for that agent. The sender does not pick the merchant, the mandate or
 * a price -- the sentence they wrote is the whole of their input, and it goes
 * through exactly the path a button press on Mission Control does.
 *
 * Three things the intake never does:
 *
 *  - Treat the email as instructions. The body is a *request for goods*; it is
 *    read by the same conservative keyword matcher as any buyer message, and
 *    anything in it that is not a product and a quantity is ignored.
 *  - Reply before the gate has decided. The receipt reports what happened; it
 *    never promises what will.
 *  - Send the same receipt twice. Every outbound email carries an idempotency
 *    key derived from the run, so a retry after a crash is a no-op at the port.
 */

/** The business this inbox serves. One inbox, one buyer, one signed budget. */
export const BUSINESS = {
  name: "Harbor Street Café",
  merchant_id: "mch_bulk",
  mandate_id: "mnd_restaurant_restock",
} as const;

export interface IntakeOutcome {
  run_id: string;
  session_seq_before: number;
  email_id: string;
  /** What the gate did with it. */
  result: "captured" | "step_up" | "denied" | "failed";
  order_id?: string;
  amount_cents?: number;
  cart: NamedLine[];
  link_url?: string;
  denial?: string;
  /** The reply that went back, if the mail port took it. */
  receipt?: SentEmail;
  receipt_error?: string;
  approval_post?: PostedMessage;
  summary_post?: PostedMessage;
  delivery?: CreatedEvent;
  log?: AppendedRow;
}

/**
 * Pull whatever is waiting and process each request in turn.
 *
 * One at a time on purpose. Two emails processed concurrently would race for
 * the same envelope and the same stock, and the second one's receipt would
 * describe a world the first had already changed.
 */
export async function pullAndProcess(
  mode: "scripted" | "llm",
  origin: string,
  opts: IntakeOptions = {},
): Promise<IntakeOutcome[]> {
  const m = mercury();
  const inbox = await m.mail.pull();
  const out: IntakeOutcome[] = [];
  for (const email of inbox) out.push(await processEmail(email, mode, origin, opts));
  return out;
}

export interface IntakeOptions {
  /**
   * The crash drill. After the gate has decided and any payment has been
   * captured, every app action is written to the outbox and *held* -- exactly
   * the state a process that died at that instant would leave behind. The
   * outbox's release is the restart, and it must finish the run without a
   * second email, a second post or a second calendar entry.
   */
  crashAfterPayment?: boolean;
  /** Skip the presentation beats. The failure drills run many emails and should not wait for a watcher. */
  noPace?: boolean;
}

export async function processEmail(
  email: InboundEmail,
  mode: "scripted" | "llm",
  origin: string,
  opts: IntakeOptions = {},
): Promise<IntakeOutcome> {
  const m = mercury();
  const runId = newId("session");
  const seqBefore = m.ledger.count();

  m.ledger.append({
    actor: { type: "app", id: m.mail.mode === "live" ? "gmail" : "gmail_fixture" },
    event_type: "EMAIL_RECEIVED",
    session_id: runId,
    detail: {
      message_id: email.id,
      from: email.from,
      subject: email.subject,
      chars: email.text.length,
      received_at: email.received_at,
      business: BUSINESS.name,
    },
  });

  const scenario: Scenario = {
    id: "intake",
    label: email.subject === "" ? "(no subject)" : email.subject,
    premise: `An email from ${email.from}, taken up by ${BUSINESS.name}'s purchasing agent.`,
    merchant_id: BUSINESS.merchant_id,
    mandate_id: BUSINESS.mandate_id,
    buyer: email.text,
    // No injection and no `want`: the cart is read out of the email itself.
    scripted: {},
  };

  const outcome: IntakeOutcome = {
    run_id: runId,
    session_seq_before: seqBefore,
    email_id: email.id,
    result: "denied",
    cart: [],
  };
  const denials: string[] = [];
  let sawOffer = false;
  let merchantReply = "";

  /*
   * A beat between events. The work is instantaneous; a person watching the
   * strip is not. Zero under test, and only ever presentation: nothing here
   * waits for anything but the clock.
   */
  const pace = async (): Promise<void> => {
    const ms = opts.noPace === true ? 0 : Number(process.env["MERCURY_PACE_MS"] ?? "350");
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  };

  const publish = async (event: TheatreEvent): Promise<void> => {
    bus().publish(runId, "email", event);
    switch (event.type) {
      case "offer":
        sawOffer = true;
        break;
      case "merchant":
        merchantReply = event.text;
        break;
      case "order": {
        const catalog = m.store.catalogFor(BUSINESS.merchant_id);
        outcome.order_id = event.order_id;
        outcome.amount_cents = event.amount_cents;
        outcome.cart = event.cart.map((l) => ({ ...l, title: catalog.get(l.sku)?.title ?? l.sku }));
        break;
      }
      case "verdict":
        if (event.outcome === "DENY") denials.push(...event.messages);
        break;
      case "stepup":
        outcome.result = "step_up";
        outcome.link_url = event.link_url;
        break;
      case "payment":
        if (event.status === "captured") outcome.result = "captured";
        else if (event.status === "fallback" && outcome.result !== "captured") outcome.result = "failed";
        break;
      default:
        break;
    }
    if (event.type !== "done") await pace();
  };

  // The trigger, narrated first so a watcher sees where the run came from.
  await publish({ type: "note", text: `Email from ${email.from}: "${email.subject}"` });

  try {
    await runScenario(scenario, mode, publish, { sessionId: runId });
  } catch (e) {
    outcome.result = "failed";
    denials.push((e as Error).message);
    await publish({ type: "note", text: `Run failed: ${(e as Error).message}` });
  }

  if (outcome.result === "denied") {
    // Two different refusals, and the reply must say which. A cart the gate
    // denied is a limit doing its job; a message with no cart in it never
    // reached the gate at all.
    outcome.denial = sawOffer
      ? (denials.at(-1) ?? "the gate refused the cart")
      : `I couldn't find anything in your message that ${merchantName()} sells. ` +
        `Name the items and quantities, e.g. "10 bags of coffee beans". ${merchantReply}`.trim();
  }
  if (outcome.result === "failed" && outcome.denial === undefined) outcome.denial = denials.at(-1);

  if (opts.crashAfterPayment === true) {
    holdRun(runId);
    await publish({ type: "note", text: "Crash drill: the process dies here. Debts are written; nothing has gone out." });
  }

  // Calendar, chat, then mail. The delivery goes on first so the receipt can
  // say it is there; the approval request is time-sensitive; the receipt is the
  // record. Each is independent -- a failure in one does not stop the others,
  // and none of them can reach back to the payment.
  await bookDelivery(outcome);
  await pace();
  await logPurchase(email, outcome, origin);
  await pace();
  await notifyTeam(email, outcome, origin);
  await pace();
  await reply(email, outcome, origin);
  return outcome;
}

function merchantName(): string {
  return mercury().store.getMerchant(BUSINESS.merchant_id)?.display_name ?? BUSINESS.merchant_id;
}

/* ------------------------------------------------------------------ reply --- */

async function reply(email: InboundEmail, o: IntakeOutcome, origin: string): Promise<void> {
  const m = mercury();
  const subject = `Re: ${email.subject === "" ? "your order" : email.subject}`;
  const key = `receipt:${o.run_id}`;

  const sent = await appAction<SentEmail>({
    run_id: o.run_id,
    idempotency_key: key,
    event_type: "EMAIL_SENT",
    detail: { to: email.from, subject, kind: o.result, ...(o.order_id === undefined ? {} : { order_id: o.order_id }) },
    payload: {
      app: "gmail",
      action: "send_receipt",
      email: { to: email.from, subject, text: receiptText(o, origin), idempotency_key: key, in_reply_to: email.id },
    },
  });
  if (sent.ok) o.receipt = sent.value;
  else o.receipt_error = sent.error;
}

/* --------------------------------------------------------------- calendar --- */

/**
 * The delivery window, on the business's calendar.
 *
 * Only for an order that was paid: a step-up has not been released, a denial
 * bought nothing. Two days out, a two-hour morning window -- a stand-in for a
 * supplier's real delivery promise, which the feed does not carry yet.
 */
async function bookDelivery(o: IntakeOutcome): Promise<void> {
  if (o.result !== "captured" || o.order_id === undefined) return;
  const m = mercury();
  const start = new Date(Date.now() + 2 * 86_400_000);
  start.setUTCHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 3_600_000);
  const key = `delivery:${o.run_id}`;
  const orderId = o.order_id;

  const created = await appAction<CreatedEvent>({
    run_id: o.run_id,
    idempotency_key: key,
    event_type: "CALENDAR_EVENT_CREATED",
    detail: { order_id: orderId, start: start.toISOString(), end: end.toISOString() },
    payload: {
      app: "google_calendar",
      action: "book_delivery",
      event: {
        title: `Delivery — ${merchantName()}`,
        description: [
          ...o.cart.map((l) => `${l.qty} x ${l.title}`),
          "",
          `Order ${orderId} · ${dollars(o.amount_cents ?? 0)} · placed by Mercury for ${BUSINESS.name}`,
        ].join("\n"),
        start: start.toISOString(),
        end: end.toISOString(),
        order_id: orderId,
        idempotency_key: key,
      },
    },
  });
  if (created.ok) o.delivery = created.value;
}

/* ------------------------------------------------------------------ sheet --- */

/** One row in the owner's purchase log, for a paid order and nothing else. */
async function logPurchase(email: InboundEmail, o: IntakeOutcome, origin: string): Promise<void> {
  if (o.result !== "captured" || o.order_id === undefined) return;
  const key = `log:${o.run_id}`;
  const logged = await appAction<AppendedRow>({
    run_id: o.run_id,
    idempotency_key: key,
    event_type: "SHEET_ROW_APPENDED",
    detail: { order_id: o.order_id, amount_cents: o.amount_cents ?? 0 },
    payload: {
      app: "google_sheets",
      action: "log_purchase",
      row: {
        date: new Date().toISOString().slice(0, 10),
        order_id: o.order_id,
        supplier: merchantName(),
        items: o.cart.map((l) => `${l.qty} x ${l.title}`).join(", "),
        amount_cents: o.amount_cents ?? 0,
        requested_by: email.from,
        audit_url: `${origin}/api/agent/audit?session_id=${encodeURIComponent(o.run_id)}`,
        idempotency_key: key,
      },
    },
  });
  if (logged.ok) o.log = logged.value;
}

/* ------------------------------------------------------------------- chat --- */

/**
 * Tell the team.
 *
 * An approval request when the gate has stopped the run for a human; a
 * one-line summary otherwise. Chat is told, never asked: nothing posted here
 * is read back, and a reply in the channel releases no money -- the link does.
 */
async function notifyTeam(email: InboundEmail, o: IntakeOutcome, origin: string): Promise<void> {
  const m = mercury();
  const audit = `${origin}/api/agent/audit?session_id=${encodeURIComponent(o.run_id)}`;
  const items = o.cart.map((l) => `${l.qty} x ${l.title}`).join(", ");

  if (o.result === "step_up") {
    const threshold = m.store.getMandate(BUSINESS.mandate_id)?.mandate.requires_human_approval_above_cents;
    const posted = await appAction<PostedMessage>({
      run_id: o.run_id,
      idempotency_key: `approval:${o.run_id}`,
      event_type: "CHAT_POSTED",
      detail: { amount_cents: o.amount_cents ?? 0, order_id: o.order_id ?? "", link: o.link_url ?? "" },
      payload: {
        app: "slack",
        action: "approval_request",
        message: {
          kind: "approval_request",
          text: `Needs your OK: ${dollars(o.amount_cents ?? 0)} for ${items}`,
          fields: [
            { label: "Asked by", value: email.from },
            { label: "Why", value: threshold === undefined ? "above the agent's own limit" : `above the ${dollars(threshold)} you let the agent spend on its own` },
            { label: "Charged so far", value: "$0.00" },
          ],
          link: { label: "Approve or decline", url: o.link_url ?? audit },
          idempotency_key: `approval:${o.run_id}`,
        },
      },
    });
    if (posted.ok) o.approval_post = posted.value;
    return;
  }

  const text =
    o.result === "captured"
      ? `Paid ${dollars(o.amount_cents ?? 0)} to ${merchantName()} for ${items}`
      : o.result === "denied"
        ? `Declined an order from ${email.from}: ${o.denial ?? "the gate refused it"}`
        : `Payment failed for ${items}; handed to a human`;

  const posted = await appAction<PostedMessage>({
    run_id: o.run_id,
    idempotency_key: `summary:${o.run_id}`,
    event_type: "CHAT_POSTED",
    detail: { kind: o.result, ...(o.order_id === undefined ? {} : { order_id: o.order_id }) },
    payload: {
      app: "slack",
      action: "summary",
      message: {
        kind: "summary",
        text,
        fields: [
          { label: "Asked by", value: email.from },
          ...(o.order_id === undefined ? [] : [{ label: "Order", value: o.order_id }]),
        ],
        link: { label: "Audit trail", url: audit },
        idempotency_key: `summary:${o.run_id}`,
      },
    },
  });
  if (posted.ok) o.summary_post = posted.value;
}

/** The receipt, in the words a café manager would want to read. */
export function receiptText(o: IntakeOutcome, origin: string): string {
  const lines = o.cart.map((l) => `  ${l.qty} x ${l.title} — ${dollars(l.line_total_cents)}`);
  const audit = `${origin}/api/agent/audit?session_id=${encodeURIComponent(o.run_id)}`;
  const footer = [
    "",
    "— Mercury, purchasing agent for " + BUSINESS.name,
    `Every step of this order is in a tamper-evident record: ${audit}`,
  ];

  switch (o.result) {
    case "captured":
      return [
        `Done. Your order is placed and paid: ${dollars(o.amount_cents ?? 0)}.`,
        "",
        ...lines,
        "",
        o.delivery === undefined
          ? `Order ${o.order_id ?? ""}.`
          : `Order ${o.order_id ?? ""}. Delivery is on the calendar for ${o.delivery.start.slice(0, 10)}.`,
        ...footer,
      ].join("\n");
    case "step_up":
      return [
        `This one needs your OK before any money moves: ${dollars(o.amount_cents ?? 0)}.`,
        "",
        ...lines,
        "",
        "It is above the amount you allowed the agent to spend on its own.",
        `Approve or decline here: ${o.link_url ?? ""}`,
        "Nothing has been charged.",
        ...footer,
      ].join("\n");
    case "denied":
      return [
        "I couldn't place this order.",
        "",
        `Reason: ${o.denial ?? "the gate refused the cart"}`,
        "",
        "Nothing was charged. Reply with a smaller order, or change the limits in the merchant console.",
        ...footer,
      ].join("\n");
    default:
      return [
        "The order was approved but the payment did not go through.",
        "",
        ...lines,
        "",
        o.link_url === undefined
          ? "Nothing was charged."
          : `You can complete it yourself here: ${o.link_url}. Nothing has been charged automatically.`,
        ...footer,
      ].join("\n");
  }
}
