import { GoogleAuth, type ServiceAccount } from "./google.js";

/**
 * Calendar -- what happens next, on the business's own calendar.
 *
 * One port, two implementations, chosen by `CALENDAR_MODE`:
 *
 *   FixtureCalendar  in-memory. `events()` is what a test reads.
 *   GoogleCalendar   a Google Cloud service account writing to one calendar
 *                    that has been shared with it. Two HTTP calls -- a JWT for
 *                    a token, then `events.insert` -- so the SDK stays out.
 *
 * The agent creates exactly one kind of entry: a delivery window for an order
 * it has paid for. It never reads the calendar, never moves or deletes an
 * event, and never books anything the gate did not approve.
 */

export interface CalendarEventInput {
  title: string;
  description: string;
  /** ISO 8601. */
  start: string;
  end: string;
  /** Stored on the event, so the calendar entry points back at the order. */
  order_id: string;
  /** Same rule as mail and chat: one key, one event, retries are no-ops. */
  idempotency_key: string;
}

export interface CreatedEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  /** A link a human can open. */
  html_link: string;
  idempotency_key: string;
  deduplicated: boolean;
}

export interface CalendarPort {
  readonly mode: "fixture" | "live";
  create(event: CalendarEventInput): Promise<CreatedEvent>;
}

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarError";
  }
}

/* ------------------------------------------------------------------ fixture */

export class FixtureCalendar implements CalendarPort {
  readonly mode = "fixture" as const;
  readonly calendarId: string;

  #counter = 0;
  readonly #events: (CreatedEvent & { input: CalendarEventInput })[] = [];
  readonly #byKey = new Map<string, CreatedEvent>();
  #failNext: { reason: string; times: number } | undefined;

  constructor(opts: { calendarId?: string } = {}) {
    this.calendarId = opts.calendarId ?? "deliveries@mercury.test";
  }

  /** Make the next `create` fail -- "the calendar API is down", for a chaos row. */
  failNext(reason = "google calendar: 500 backend error", times = 1): void {
    this.#failNext = { reason, times };
  }

  async create(input: CalendarEventInput): Promise<CreatedEvent> {
    const prior = this.#byKey.get(input.idempotency_key);
    if (prior !== undefined) return { ...prior, deduplicated: true };

    if (this.#failNext !== undefined) {
      const { reason } = this.#failNext;
      this.#failNext.times -= 1;
      if (this.#failNext.times <= 0) this.#failNext = undefined;
      throw new CalendarError(reason);
    }

    this.#counter += 1;
    const id = `gcal_FIX${String(this.#counter).padStart(5, "0")}`;
    const created: CreatedEvent = {
      id,
      title: input.title,
      start: input.start,
      end: input.end,
      html_link: `https://calendar.google.com/calendar/event?eid=${id}`,
      idempotency_key: input.idempotency_key,
      deduplicated: false,
    };
    this.#events.push({ ...created, input });
    this.#byKey.set(input.idempotency_key, created);
    return created;
  }

  /** The calendar, in creation order. */
  events(): readonly (CreatedEvent & { input: CalendarEventInput })[] {
    return this.#events;
  }
}

/* ----------------------------------------------------------- Google Calendar */

export interface GoogleCalendarOptions {
  serviceAccount: ServiceAccount;
  /** The calendar the service account has been given "make changes" on. */
  calendarId: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendar implements CalendarPort {
  readonly mode = "live" as const;

  readonly #auth: GoogleAuth;
  readonly #calendarId: string;
  readonly #fetch: typeof fetch;
  readonly #byKey = new Map<string, CreatedEvent>();

  constructor(opts: GoogleCalendarOptions) {
    if (opts.serviceAccount.client_email === "" || opts.serviceAccount.private_key === "") {
      throw new CalendarError("GoogleCalendar needs a service account with client_email and private_key");
    }
    if (opts.calendarId === "") throw new CalendarError("GoogleCalendar needs GOOGLE_CALENDAR_ID");
    this.#auth = new GoogleAuth(opts.serviceAccount, {
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    this.#calendarId = opts.calendarId;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async create(input: CalendarEventInput): Promise<CreatedEvent> {
    const prior = this.#byKey.get(input.idempotency_key);
    if (prior !== undefined) return { ...prior, deduplicated: true };

    const token = await this.#auth.accessToken(SCOPE);
    const res = await this.#fetch(`${API}/calendars/${encodeURIComponent(this.#calendarId)}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: input.title,
        description: input.description,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
        extendedProperties: {
          private: { mercury_order_id: input.order_id, mercury_idempotency_key: input.idempotency_key },
        },
      }),
    });
    if (!res.ok) {
      throw new CalendarError(`google calendar: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { id: string; htmlLink?: string };

    const created: CreatedEvent = {
      id: body.id,
      title: input.title,
      start: input.start,
      end: input.end,
      html_link: body.htmlLink ?? "",
      idempotency_key: input.idempotency_key,
      deduplicated: false,
    };
    this.#byKey.set(input.idempotency_key, created);
    return created;
  }
}
