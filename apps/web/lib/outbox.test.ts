import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The outbox, end to end, against a real SQLite file and the fixture ports.
 *
 * The property under test is the multi-app version of "no double charge": an
 * action owed after a payment happens exactly once, whether the process that
 * owed it finishes, crashes, or retries.
 */

const dir = mkdtempSync(join(tmpdir(), "mercury-outbox-"));
process.env["MERCURY_DB"] = join(dir, "test.db");
process.env["MERCURY_WALLET"] = join(dir, "wallet.json");
process.env["RAIL_MODE"] = "fixture";
process.env["MAIL_MODE"] = "fixture";
process.env["CHAT_MODE"] = "fixture";
process.env["CALENDAR_MODE"] = "fixture";

// Imported after the environment is set: `mercury()` reads it once.
const { mercury, reset } = await import("./mercury");
const { MAX_ATTEMPTS, drain, holdRun, owe, release, stopOutbox } = await import("./outbox");

function receipt(run: string, key = `receipt:${run}`) {
  return {
    run_id: run,
    idempotency_key: key,
    event_type: "EMAIL_SENT" as const,
    detail: { to: "m@cafe.test" },
    payload: {
      app: "gmail" as const,
      action: "send_receipt" as const,
      email: { to: "m@cafe.test", subject: "Re: order", text: "Done.", idempotency_key: key },
    },
  };
}

function delivery(run: string) {
  const key = `delivery:${run}`;
  return {
    run_id: run,
    idempotency_key: key,
    event_type: "CALENDAR_EVENT_CREATED" as const,
    detail: { order_id: "pi_x" },
    payload: {
      app: "google_calendar" as const,
      action: "book_delivery" as const,
      event: {
        title: "Delivery",
        description: "",
        start: "2026-09-16T09:00:00.000Z",
        end: "2026-09-16T11:00:00.000Z",
        order_id: "pi_x",
        idempotency_key: key,
      },
    },
  };
}

function ledgerTypes(run: string): string[] {
  const l = mercury().ledger;
  return [...l.byEventType("EMAIL_SENT"), ...l.byEventType("APP_ACTION_FAILED"), ...l.byEventType("CALENDAR_EVENT_CREATED")]
    .filter((e) => e.session_id === run)
    .map((e) => e.event_type);
}

function sentFor(key: string): number {
  return mercury().fixtureMail?.sent().filter((s) => s.idempotency_key === key).length ?? 0;
}

/** Advance to just past a row's next scheduled attempt, instead of waiting for it. */
async function drainPast(key: string): Promise<void> {
  const row = mercury().store.getOutbox(key);
  await drain(new Date(new Date(row?.next_attempt_at ?? 0).getTime() + 1));
}

beforeAll(() => {
  reset();
});

afterAll(() => {
  stopOutbox();
  mercury().ledger.close();
  mercury().store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("owe", () => {
  it("records the debt, pays it, and writes the ledger event once", async () => {
    const r = await owe(receipt("ses_o1"));
    expect(r.status).toBe("done");
    expect(mercury().store.getOutbox("receipt:ses_o1")?.status).toBe("done");
    expect(sentFor("receipt:ses_o1")).toBe(1);
    expect(ledgerTypes("ses_o1")).toEqual(["EMAIL_SENT"]);
  });

  it("owing the same key again does nothing -- no second email, no second entry", async () => {
    await owe(receipt("ses_o1"));
    await drain();
    expect(sentFor("receipt:ses_o1")).toBe(1);
    expect(ledgerTypes("ses_o1")).toEqual(["EMAIL_SENT"]);
  });
});

describe("the crash drill", () => {
  it("a held run leaves its debts pending and nothing sent; release finishes each exactly once", async () => {
    holdRun("ses_crash");
    const r = await owe(receipt("ses_crash"));
    expect(r.status).toBe("held");
    expect(mercury().store.getOutbox("receipt:ses_crash")?.status).toBe("pending");
    expect(sentFor("receipt:ses_crash")).toBe(0);
    expect(ledgerTypes("ses_crash")).toEqual([]);

    const rows = await release();
    expect(rows.map((x) => [x.idempotency_key, x.status])).toEqual([["receipt:ses_crash", "done"]]);
    expect(sentFor("receipt:ses_crash")).toBe(1);
    expect(ledgerTypes("ses_crash")).toEqual(["EMAIL_SENT"]);

    // A second "restart" finds nothing owed.
    expect(await release()).toEqual([]);
    expect(sentFor("receipt:ses_crash")).toBe(1);
  });
});

describe("bounded retries", () => {
  it("a failing action is retried, then given up as APP_ACTION_FAILED", async () => {
    const cal = mercury().fixtureCalendar;
    if (cal === undefined) throw new Error("fixture calendar expected");

    cal.failNext("google calendar: 500 backend error");
    const first = await owe(delivery("ses_retry"));
    expect(first.status).toBe("pending");
    if (first.status !== "pending") throw new Error("unreachable");
    expect(first.attempts).toBe(1);
    expect(first.last_error).toMatch(/500/);

    cal.failNext("google calendar: 500 backend error");
    await drainPast("delivery:ses_retry");
    expect(mercury().store.getOutbox("delivery:ses_retry")?.attempts).toBe(2);
    expect(mercury().store.getOutbox("delivery:ses_retry")?.status).toBe("pending");

    cal.failNext("google calendar: 500 backend error");
    await drainPast("delivery:ses_retry");
    const final = mercury().store.getOutbox("delivery:ses_retry");
    expect(final?.status).toBe("failed");
    expect(final?.attempts).toBe(MAX_ATTEMPTS);
    expect(ledgerTypes("ses_retry")).toEqual(["APP_ACTION_FAILED"]);
    expect(cal.events().filter((e) => e.idempotency_key === "delivery:ses_retry")).toHaveLength(0);
  });

  it("a failure followed by a success is recorded once, with the attempt count", async () => {
    const cal = mercury().fixtureCalendar;
    if (cal === undefined) throw new Error("fixture calendar expected");
    cal.failNext();
    await owe(delivery("ses_retry_ok"));
    await drainPast("delivery:ses_retry_ok");

    const done = mercury().store.getOutbox("delivery:ses_retry_ok");
    expect(done?.status).toBe("done");
    expect(done?.attempts).toBe(2);
    expect(ledgerTypes("ses_retry_ok")).toEqual(["CALENDAR_EVENT_CREATED"]);
    const entry = mercury().ledger.byEventType("CALENDAR_EVENT_CREATED").find((e) => e.session_id === "ses_retry_ok");
    expect((entry?.detail as { attempts?: number } | undefined)?.attempts).toBe(2);
  });
});
