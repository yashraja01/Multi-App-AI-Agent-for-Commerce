import { GoogleAuth, type ServiceAccount } from "./google.js";

/**
 * Sheet -- the business's purchase log, where the owner already keeps it.
 *
 * One port, two implementations, chosen by `SHEETS_MODE`:
 *
 *   FixtureSheet   in-memory rows. `rows()` is what a test reads.
 *   GoogleSheet    one tab of one Google Sheet, shared with the same service
 *                  account the calendar uses. One HTTP call: `values:append`.
 *
 * The agent appends. It never reads the sheet, never edits a row, and never
 * logs anything the gate did not approve and Stripe did not capture. The
 * sheet is the owner's copy of the record; the ledger is the record.
 */

/** One paid order, as the columns an owner would want to sort by. */
export interface PurchaseRow {
  date: string;
  order_id: string;
  supplier: string;
  items: string;
  amount_cents: number;
  requested_by: string;
  /** A link to the run's own audit trail. */
  audit_url: string;
  /** Same rule as the other ports: one key, one row. */
  idempotency_key: string;
}

export interface AppendedRow {
  id: string;
  /** Where the row landed, e.g. `Purchases!A12:H12`. */
  range: string;
  idempotency_key: string;
  deduplicated: boolean;
}

export interface SheetPort {
  readonly mode: "fixture" | "live";
  append(row: PurchaseRow): Promise<AppendedRow>;
}

export class SheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetError";
  }
}

export const COLUMNS = ["Date", "Order", "Supplier", "Items", "Amount", "Requested by", "Audit trail"] as const;

/** A row as the sheet sees it: one cell per column, amount in dollars. */
export function cellsOf(r: PurchaseRow): string[] {
  return [
    r.date,
    r.order_id,
    r.supplier,
    r.items,
    (r.amount_cents / 100).toFixed(2),
    r.requested_by,
    r.audit_url,
  ];
}

/* ------------------------------------------------------------------ fixture */

export class FixtureSheet implements SheetPort {
  readonly mode = "fixture" as const;
  readonly sheetId: string;
  readonly tab: string;

  readonly #rows: (AppendedRow & { row: PurchaseRow })[] = [];
  readonly #byKey = new Map<string, AppendedRow>();
  #failNext: { reason: string; times: number } | undefined;

  constructor(opts: { sheetId?: string; tab?: string } = {}) {
    this.sheetId = opts.sheetId ?? "purchases-fixture";
    this.tab = opts.tab ?? "Purchases";
  }

  /** Make the next `append` fail -- "Sheets is down", for a chaos row. */
  failNext(reason = "google sheets: 503 backend error", times = 1): void {
    this.#failNext = { reason, times };
  }

  async append(row: PurchaseRow): Promise<AppendedRow> {
    const prior = this.#byKey.get(row.idempotency_key);
    if (prior !== undefined) return { ...prior, deduplicated: true };

    if (this.#failNext !== undefined) {
      const { reason } = this.#failNext;
      this.#failNext.times -= 1;
      if (this.#failNext.times <= 0) this.#failNext = undefined;
      throw new SheetError(reason);
    }

    const n = this.#rows.length + 2; // row 1 is the header
    const appended: AppendedRow = {
      id: `row_FIX${String(n).padStart(5, "0")}`,
      range: `${this.tab}!A${n}:G${n}`,
      idempotency_key: row.idempotency_key,
      deduplicated: false,
    };
    this.#rows.push({ ...appended, row });
    this.#byKey.set(row.idempotency_key, appended);
    return appended;
  }

  /** The log, oldest first. */
  rows(): readonly (AppendedRow & { row: PurchaseRow })[] {
    return this.#rows;
  }
}

/* ------------------------------------------------------------ Google Sheets */

export interface GoogleSheetOptions {
  serviceAccount: ServiceAccount;
  /** The spreadsheet id from its URL. Shared with the service account as an editor. */
  sheetId: string;
  /** The tab. Created by the owner; the port appends to it. */
  tab?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

export class GoogleSheet implements SheetPort {
  readonly mode = "live" as const;

  readonly #auth: GoogleAuth;
  readonly #sheetId: string;
  readonly #tab: string;
  readonly #fetch: typeof fetch;
  readonly #byKey = new Map<string, AppendedRow>();

  constructor(opts: GoogleSheetOptions) {
    if (opts.serviceAccount.client_email === "" || opts.serviceAccount.private_key === "") {
      throw new SheetError("GoogleSheet needs a service account with client_email and private_key");
    }
    if (opts.sheetId === "") throw new SheetError("GoogleSheet needs GOOGLE_SHEET_ID");
    this.#auth = new GoogleAuth(opts.serviceAccount, {
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    this.#sheetId = opts.sheetId;
    this.#tab = opts.tab ?? "Purchases";
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async append(row: PurchaseRow): Promise<AppendedRow> {
    const prior = this.#byKey.get(row.idempotency_key);
    if (prior !== undefined) return { ...prior, deduplicated: true };

    const token = await this.#auth.accessToken(SCOPE);
    const range = encodeURIComponent(`${this.#tab}!A:G`);
    const res = await this.#fetch(
      `${API}/${encodeURIComponent(this.#sheetId)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ majorDimension: "ROWS", values: [cellsOf(row)] }),
      },
    );
    if (!res.ok) {
      throw new SheetError(`google sheets: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { updates?: { updatedRange?: string } };
    const updated = body.updates?.updatedRange ?? `${this.#tab}!?`;

    const appended: AppendedRow = {
      id: `row_${updated.replace(/[^A-Za-z0-9]+/gu, "_")}`,
      range: updated,
      idempotency_key: row.idempotency_key,
      deduplicated: false,
    };
    this.#byKey.set(row.idempotency_key, appended);
    return appended;
  }
}
