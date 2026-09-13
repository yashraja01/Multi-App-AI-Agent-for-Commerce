import { BUSINESS, pullAndProcess } from "@/lib/intake";
import { calendarMode, chatMode, mailMode, mercury, sheetsMode } from "@/lib/mercury";
import { ensureMailPoller } from "@/lib/mail-poller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The agent's inbox, from the outside.
 *
 * POST with an email body in fixture mode is the "send a test email" button:
 * the message is dropped into the fixture inbox and then *pulled and processed
 * exactly as a real one would be* -- inject, pull, process is the same three
 * steps Gmail goes through, so the demo path and the live path are one path.
 *
 * POST with no body (or in live mode) means "check the inbox now" -- the same
 * pull the background poller does on its own timer.
 *
 * GET shows the fixture's Sent folder, so a test can read the receipt back.
 */
export async function POST(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  ensureMailPoller(origin);

  const text = await req.text();
  const body =
    text === ""
      ? {}
      : (JSON.parse(text) as {
          from?: string;
          subject?: string;
          text?: string;
          mode?: string;
          /** Fixture only: make the receipt bounce. The failure drill for mail. */
          bounce_receipt?: boolean;
          /** Fixture only: make the Slack post fail. The failure drill for chat. */
          fail_chat?: boolean;
          /** Fixture only: make the calendar insert fail. The failure drill for calendar. */
          fail_calendar?: boolean;
          /** Fixture only: make the purchase-log append fail. */
          fail_sheet?: boolean;
          /**
           * The crash drill: the process "dies" after the payment, before any
           * app action runs. The debts are written to the outbox and held there;
           * POST /api/ops/outbox {"action":"release"} is the restart.
           */
          crash_after_payment?: boolean;
          /** No presentation beats. For `npm run eval`, never for a watcher. */
          fast?: boolean;
        });
  const mode = body.mode === "llm" ? "llm" : "scripted";

  const m = mercury();
  if (typeof body.text === "string" && body.text !== "") {
    if (m.fixtureMail === undefined) {
      return Response.json(
        { error: "the inbox is live Gmail; send the email to the agent's address instead of posting it here" },
        { status: 409 },
      );
    }
    m.fixtureMail.inject({
      from: body.from ?? "manager@cafe.test",
      subject: body.subject ?? "Restock",
      text: body.text,
    });
    if (body.bounce_receipt === true) m.fixtureMail.failNext("550 5.1.1 mailbox unavailable");
    if (body.fail_chat === true) m.fixtureChat?.failNext();
    if (body.fail_calendar === true) m.fixtureCalendar?.failNext();
    if (body.fail_sheet === true) m.fixtureSheet?.failNext();
  }

  const outcomes = await pullAndProcess(mode, origin, {
    crashAfterPayment: body.crash_after_payment === true,
    noPace: body.fast === true,
  });
  return Response.json({
    mail_mode: mailMode(),
    chat_mode: chatMode(),
    calendar_mode: calendarMode(),
    sheets_mode: sheetsMode(),
    business: BUSINESS,
    processed: outcomes,
  });
}

export async function GET(req: Request): Promise<Response> {
  ensureMailPoller(new URL(req.url).origin);
  const m = mercury();
  return Response.json({
    mail_mode: mailMode(),
    business: BUSINESS,
    address: m.fixtureMail?.address ?? process.env["GMAIL_USER"] ?? "",
    sent: m.fixtureMail?.sent() ?? [],
    chat_mode: chatMode(),
    channel: m.fixtureChat?.channel ?? "(slack webhook)",
    posted: m.fixtureChat?.posted() ?? [],
    calendar_mode: calendarMode(),
    calendar: m.fixtureCalendar?.calendarId ?? process.env["GOOGLE_CALENDAR_ID"] ?? "",
    events: m.fixtureCalendar?.events() ?? [],
    sheets_mode: sheetsMode(),
    sheet: m.fixtureSheet === undefined ? process.env["GOOGLE_SHEET_ID"] ?? "" : `${m.fixtureSheet.sheetId} / ${m.fixtureSheet.tab}`,
    rows: m.fixtureSheet?.rows() ?? [],
  });
}
