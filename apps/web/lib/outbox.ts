import "server-only";
import type { CalendarEventInput, ChatMessage, OutboundEmail, PurchaseRow } from "@mercury/apps";
import type { EventType } from "@mercury/ledger";
import type { OutboxRow } from "@mercury/store";
import { bus } from "./bus";
import { mercury } from "./mercury";

/**
 * The outbox: every external-app action, owed before it is attempted.
 *
 * The problem it solves is the multi-app version of a double charge. The
 * payment is captured; then the process dies before the receipt goes out. On
 * restart, did the receipt go? Without a record, the choice is between
 * sending it again (and sometimes twice) or never (and sometimes losing it).
 *
 * So the debt is written first -- one row per action, keyed by an idempotency
 * key, in the same SQLite file as the order -- and only then attempted. A
 * crash at any point leaves a row that says exactly what is owed. On boot the
 * pending rows are drained; a row that already went is `done` and is not
 * retried; a port that is asked twice for the same key answers with the
 * original. Three layers, and the middle one is the one that survives a
 * restart.
 *
 * Retries are bounded (`MAX_ATTEMPTS`, short backoff). When the budget is
 * spent the row is marked `failed` and the ledger gets `APP_ACTION_FAILED`.
 * Nothing here can reach the payment: the outbox knows what it owes, not how
 * the money moved.
 */

export type AppName = "gmail" | "slack" | "google_calendar" | "google_sheets";

/** The self-contained instruction a row carries. Everything needed to act, and nothing else. */
export type OutboxPayload =
  | { app: "gmail"; action: "send_receipt"; email: OutboundEmail }
  | { app: "slack"; action: "approval_request" | "summary"; message: ChatMessage }
  | { app: "google_calendar"; action: "book_delivery"; event: CalendarEventInput }
  | { app: "google_sheets"; action: "log_purchase"; row: PurchaseRow };

export interface OweArgs {
  run_id: string;
  idempotency_key: string;
  payload: OutboxPayload;
  /** The ledger event written on success, and what goes in its detail. */
  event_type: EventType;
  detail: Record<string, unknown>;
}

export interface Settled {
  id: string;
  deduplicated: boolean;
}

export type OweResult =
  | { status: "done"; value: Settled; attempts: number }
  | { status: "pending"; attempts: number; last_error: string | null }
  | { status: "failed"; attempts: number; last_error: string | null }
  | { status: "held" };

export const MAX_ATTEMPTS = 3;
/** Seconds before the 2nd and 3rd attempts. Short: this is a demo, and a human is watching. */
const BACKOFF_SECONDS = [2, 5];

/* ------------------------------------------------------------------- state */

declare global {
  // eslint-disable-next-line no-var
  var __mercury_outbox__:
    | {
        /** Runs whose drain is held -- the "process died here" drill. */
        held: Set<string>;
        timer: ReturnType<typeof setTimeout> | undefined;
        bootTimer: ReturnType<typeof setTimeout> | undefined;
        draining: boolean;
        /** Set by `stopOutbox()`; cleared by the next boot. A stopped outbox never touches the database. */
        stopped: boolean;
      }
    | undefined;
}

function state(): NonNullable<typeof globalThis.__mercury_outbox__> {
  globalThis.__mercury_outbox__ ??= {
    held: new Set(),
    timer: undefined,
    bootTimer: undefined,
    draining: false,
    stopped: false,
  };
  return globalThis.__mercury_outbox__;
}

/**
 * Hold every action of a run in the outbox without attempting it. This is
 * what a crash between "paid" and "told the owner" looks like from the
 * database's point of view: the debts are written, nothing has gone out.
 * `release()` is the restart.
 */
export function holdRun(runId: string): void {
  state().held.add(runId);
}

export function heldRuns(): string[] {
  return [...state().held];
}

export async function release(): Promise<OutboxRow[]> {
  state().held.clear();
  return drain();
}

/** Cancel the retry timer and forget held runs. Called before the database closes. */
export function stopOutbox(): void {
  const s = state();
  if (s.timer !== undefined) clearTimeout(s.timer);
  if (s.bootTimer !== undefined) clearTimeout(s.bootTimer);
  s.timer = undefined;
  s.bootTimer = undefined;
  s.held.clear();
  s.stopped = true;
}

/* ------------------------------------------------------------------- owe --- */

/**
 * Record the debt, then try to pay it now.
 *
 * Success and failure both come back as values. The caller (the intake) reads
 * them to phrase its receipt; it never has to catch anything.
 */
export async function owe(args: OweArgs): Promise<OweResult> {
  const m = mercury();
  m.store.enqueueOutbox({
    idempotency_key: args.idempotency_key,
    run_id: args.run_id,
    app: args.payload.app,
    action: args.payload.action,
    payload: { ...args.payload, event_type: args.event_type, detail: args.detail },
  });

  if (state().held.has(args.run_id)) return { status: "held" };

  await attempt(args.idempotency_key);
  // A failed first attempt has scheduled a second; make sure something wakes
  // up for it even if no drain is otherwise due.
  armTimer();
  const row = m.store.getOutbox(args.idempotency_key);
  return outcomeOf(row);
}

function outcomeOf(row: OutboxRow | undefined): OweResult {
  if (row === undefined) return { status: "failed", attempts: 0, last_error: "row vanished" };
  if (row.status === "done") return { status: "done", value: row.result as Settled, attempts: row.attempts };
  if (row.status === "failed") return { status: "failed", attempts: row.attempts, last_error: row.last_error };
  return { status: "pending", attempts: row.attempts, last_error: row.last_error };
}

/* ----------------------------------------------------------------- drain --- */

/**
 * Attempt every due row once. Rows that fail with budget left are rescheduled
 * and a timer is armed for the earliest of them; rows out of budget are
 * failed and recorded. Called on boot, after a release, and by its own timer.
 */
export async function drain(now: Date = new Date()): Promise<OutboxRow[]> {
  const s = state();
  if (s.draining || s.stopped) return [];
  s.draining = true;
  const touched: OutboxRow[] = [];
  try {
    const m = mercury();
    for (const row of m.store.dueOutbox(now.toISOString())) {
      if (s.held.has(row.run_id)) continue;
      await attempt(row.idempotency_key);
      const after = m.store.getOutbox(row.idempotency_key);
      if (after !== undefined) touched.push(after);
    }
  } finally {
    s.draining = false;
  }
  armTimer();
  return touched;
}

/** Wake up for the next pending row, if there is one. */
function armTimer(): void {
  const s = state();
  if (s.timer !== undefined) {
    clearTimeout(s.timer);
    s.timer = undefined;
  }
  if (s.stopped) return;
  const m = mercury();
  const next = m.store
    .listOutbox({ limit: 500 })
    .filter((r) => r.status === "pending" && !s.held.has(r.run_id))
    .map((r) => new Date(r.next_attempt_at).getTime())
    .sort((a, b) => a - b)[0];
  if (next === undefined) return;
  const delay = Math.max(0, next - Date.now());
  s.timer = setTimeout(() => {
    s.timer = undefined;
    void drain();
  }, delay + 5);
  s.timer.unref?.();
}

/* --------------------------------------------------------------- attempt --- */

async function attempt(key: string): Promise<void> {
  const m = mercury();
  const row = m.store.getOutbox(key);
  if (row === undefined || row.status !== "pending") return;

  const payload = row.payload as OutboxPayload & { event_type: EventType; detail: Record<string, unknown> };
  const live = isLive(payload.app);
  const actor = { type: "app" as const, id: live ? payload.app : `${payload.app}_fixture` };
  const attemptNo = row.attempts + 1;

  try {
    const value = await perform(payload);
    m.store.completeOutbox(key, value);
    m.ledger.append({
      actor,
      event_type: payload.event_type,
      session_id: row.run_id,
      detail: {
        app: payload.app,
        action: payload.action,
        id: value.id,
        idempotency_key: key,
        deduplicated: value.deduplicated,
        attempts: attemptNo,
        ...payload.detail,
      },
    });
    bus().publish(row.run_id, "email", {
      type: "app",
      app: payload.app,
      action: payload.action,
      ok: true,
      detail: narrate(payload) + (attemptNo > 1 ? ` — on attempt ${attemptNo}` : ""),
    });
  } catch (e) {
    const reason = (e as Error).message;
    const backoff = BACKOFF_SECONDS[attemptNo - 1];
    if (attemptNo < MAX_ATTEMPTS && backoff !== undefined) {
      const next = new Date(Date.now() + backoff * 1000).toISOString();
      m.store.failOutbox(key, reason, next);
      bus().publish(row.run_id, "email", {
        type: "app",
        app: payload.app,
        action: payload.action,
        ok: false,
        detail: `${reason} — attempt ${attemptNo} of ${MAX_ATTEMPTS}, retrying in ${backoff}s`,
      });
      return;
    }
    m.store.failOutbox(key, reason, undefined);
    m.ledger.append({
      actor,
      event_type: "APP_ACTION_FAILED",
      session_id: row.run_id,
      detail: {
        app: payload.app,
        action: payload.action,
        idempotency_key: key,
        attempts: attemptNo,
        reason,
        note: "any payment in this run is unaffected; the app action is owed, not the money",
      },
    });
    bus().publish(row.run_id, "email", {
      type: "app",
      app: payload.app,
      action: payload.action,
      ok: false,
      detail: `${reason} — gave up after ${attemptNo} attempts; recorded, the payment stands`,
    });
  }
}

function isLive(app: AppName): boolean {
  const m = mercury();
  if (app === "gmail") return m.mail.mode === "live";
  if (app === "slack") return m.chat.mode === "live";
  if (app === "google_sheets") return m.sheet.mode === "live";
  return m.calendar.mode === "live";
}

async function perform(p: OutboxPayload): Promise<Settled> {
  const m = mercury();
  switch (p.app) {
    case "gmail":
      return m.mail.send(p.email);
    case "slack":
      return m.chat.post(p.message);
    case "google_calendar":
      return m.calendar.create(p.event);
    case "google_sheets":
      return m.sheet.append(p.row);
  }
}

/** One short line for the strip; the ids and the full record are in the ledger. */
function narrate(p: OutboxPayload): string {
  switch (p.app) {
    case "gmail":
      return `receipt sent to ${p.email.to.replace(/@.*$/u, "@…")}`;
    case "slack":
      return p.action === "approval_request" ? "asked the team to approve" : "summary posted";
    case "google_calendar":
      return `delivery booked for ${new Date(p.event.start).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    case "google_sheets":
      return `logged $${(p.row.amount_cents / 100).toFixed(2)} to the purchase log`;
  }
}

/* --------------------------------------------------------------- resume --- */

/**
 * The restart path. Whatever was owed when the last process died is attempted
 * now. Deferred a tick so `mercury()` has finished building before anything
 * reads through it.
 */
export function resumeOnBoot(): void {
  const s = state();
  s.stopped = false;
  if (s.bootTimer !== undefined) clearTimeout(s.bootTimer);
  s.bootTimer = setTimeout(() => {
    s.bootTimer = undefined;
    void drain().then((rows) => {
      if (rows.length > 0) console.log(`[outbox] resumed ${rows.length} pending action(s) from the last run`);
    });
  }, 0);
}

export function outboxView(runId?: string): OutboxRow[] {
  return mercury().store.listOutbox(runId === undefined ? {} : { run_id: runId });
}
