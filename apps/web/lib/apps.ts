import "server-only";
import type { EventType } from "@mercury/ledger";
import { type OutboxPayload, type OweResult, type Settled, owe } from "./outbox";

/**
 * One external-app action, recorded either way.
 *
 * Every call into Gmail, Slack or Google Calendar goes through here so that
 * three things are true of all of them and none has to remember to make them
 * true itself:
 *
 *  1. The action is *owed* before it is attempted -- a row in the outbox, in
 *     the same database as the order -- so a crash after the payment leaves a
 *     record of exactly what still has to happen, and a restart finishes it
 *     without doing it twice.
 *  2. Success is a ledger entry of the named type; failure after bounded
 *     retries is `APP_ACTION_FAILED`. Neither is thrown past this function,
 *     and neither can unwind, retry or even mention the payment that preceded
 *     it: the gate stands in front of money and only money.
 *  3. The run bus hears about every attempt, so a watching tab sees the app
 *     light up, retry, or fail, in order.
 */

export type AppName = OutboxPayload["app"];

export interface AppActionResult<T extends Settled> {
  ok: boolean;
  /** "held" means the run is parked in the outbox -- the crash drill. */
  status: OweResult["status"];
  value?: T;
  error?: string;
}

export async function appAction<T extends Settled>(args: {
  run_id: string;
  idempotency_key: string;
  payload: OutboxPayload;
  event_type: EventType;
  /** What to write on success, beyond the port's own record. */
  detail: Record<string, unknown>;
}): Promise<AppActionResult<T>> {
  const r = await owe(args);
  switch (r.status) {
    case "done":
      return { ok: true, status: "done", value: r.value as T };
    case "held":
      return { ok: false, status: "held", error: "held in the outbox (crash drill); will complete on release" };
    case "pending":
      return { ok: false, status: "pending", error: r.last_error ?? "retrying" };
    default:
      return { ok: false, status: "failed", error: r.last_error ?? "failed" };
  }
}
