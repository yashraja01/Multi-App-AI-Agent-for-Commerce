import "server-only";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Engine } from "@mercury/agent";
import { hashValue } from "@mercury/core";
import {
  type CalendarPort,
  type ChatPort,
  FixtureCalendar,
  FixtureChat,
  FixtureMail,
  FixtureSheet,
  GmailMail,
  GoogleCalendar,
  GoogleSheet,
  type MailPort,
  type ServiceAccount,
  type SheetPort,
  SlackChat,
} from "@mercury/apps";
import { FixtureRail, type PaymentPort, StripeRail } from "@mercury/rail";
import { resumeOnBoot, stopOutbox } from "./outbox";
import { ALL_ITEMS, ALL_MERCHANTS, seedPrincipals, writeWallet } from "@mercury/seed";
import { Ledger } from "@mercury/ledger";
import { Store } from "@mercury/store";

/**
 * One Mercury instance per server process.
 *
 * Held on `globalThis` so Next's dev-mode hot reload does not open a second
 * SQLite handle on the same file every time a route module is re-evaluated --
 * which would quietly give two halves of the app two different views of the
 * ledger.
 *
 * Every route that imports this must declare `export const runtime = "nodejs"`.
 * `node:sqlite` does not exist on the edge runtime.
 */

export interface Mercury {
  store: Store;
  ledger: Ledger;
  rail: PaymentPort;
  /** Present only in fixture mode, where checkout can be simulated. */
  fixture: FixtureRail | undefined;
  engine: Engine;
  /** The agent's inbox and outbox. */
  mail: MailPort;
  /** Present only when MAIL_MODE is fixture: the "send a test email" button. */
  fixtureMail: FixtureMail | undefined;
  /** The team's channel: approval requests and summaries. */
  chat: ChatPort;
  fixtureChat: FixtureChat | undefined;
  /** The business's calendar: one delivery entry per paid order. */
  calendar: CalendarPort;
  fixtureCalendar: FixtureCalendar | undefined;
  /** The business's purchase log: one row per paid order. */
  sheet: SheetPort;
  fixtureSheet: FixtureSheet | undefined;
}

declare global {
  // eslint-disable-next-line no-var
  var __mercury__: Mercury | undefined;
}

/**
 * Anchor relative paths to the repo root, not to the process cwd.
 *
 * `next dev` runs with cwd = apps/web, so a bare "./mercury.db" resolved there
 * and the app quietly kept a *second* database, separate from the one
 * `npm run seed`, `npm run demo` and `npm run verify` were using. Everything
 * appeared to work; the two stores simply never agreed. Anchoring here is the
 * fix, and it is why the path constants are computed rather than literal.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "tsconfig.base.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

function anchored(value: string): string {
  return isAbsolute(value) ? value : resolve(repoRoot(), value);
}

const DB_PATH = anchored(process.env["MERCURY_DB"] ?? "./mercury.db");
export const WALLET_PATH = anchored(process.env["MERCURY_WALLET"] ?? "./buyer-wallet.json");

function build(): Mercury {
  const store = Store.open(DB_PATH);
  const ledger = Ledger.open(DB_PATH);

  const live = process.env["RAIL_MODE"] === "live";
  // One secret, read in one place, handed to whichever rail is in use. Setting
  // STRIPE_WEBHOOK_SECRET therefore makes /api/webhook/stripe accept real
  // Stripe deliveries *without* switching RAIL_MODE, which is what makes the
  // move from fixture to live a change of environment rather than of code.
  const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"] ?? "";
  const fixture = live
    ? undefined
    : new FixtureRail(webhookSecret === "" ? {} : { webhookSecret });
  const rail: PaymentPort =
    fixture ??
    new StripeRail({
      secretKey: process.env["STRIPE_SECRET_KEY"] ?? "",
      webhookSecret,
    });

  const engine = new Engine({ store, ledger, rail });

  // Each app follows the rail's pattern: one env var picks fixture or live,
  // and nothing above the port can tell which it got.
  const fixtureMail =
    process.env["MAIL_MODE"] === "gmail"
      ? undefined
      : new FixtureMail({ address: process.env["GMAIL_USER"] ?? "agent@mercury.test" });
  const mail: MailPort =
    fixtureMail ??
    new GmailMail({
      user: process.env["GMAIL_USER"] ?? "",
      appPassword: process.env["GMAIL_APP_PASSWORD"] ?? "",
    });

  const fixtureChat = process.env["CHAT_MODE"] === "slack" ? undefined : new FixtureChat();
  const chat: ChatPort =
    fixtureChat ?? new SlackChat({ webhookUrl: process.env["SLACK_WEBHOOK_URL"] ?? "" });

  const fixtureCalendar = process.env["CALENDAR_MODE"] === "google" ? undefined : new FixtureCalendar();
  const calendar: CalendarPort =
    fixtureCalendar ??
    new GoogleCalendar({
      serviceAccount: readServiceAccount(process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] ?? ""),
      calendarId: process.env["GOOGLE_CALENDAR_ID"] ?? "",
    });

  // Sheets shares the calendar's credential: one service account, two scopes.
  const fixtureSheet = process.env["SHEETS_MODE"] === "google" ? undefined : new FixtureSheet();
  const sheet: SheetPort =
    fixtureSheet ??
    new GoogleSheet({
      serviceAccount: readServiceAccount(process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] ?? ""),
      sheetId: process.env["GOOGLE_SHEET_ID"] ?? "",
      ...(process.env["GOOGLE_SHEET_TAB"] === undefined ? {} : { tab: process.env["GOOGLE_SHEET_TAB"] }),
    });

  const instance: Mercury = {
    store,
    ledger,
    rail,
    fixture,
    engine,
    mail,
    fixtureMail,
    chat,
    fixtureChat,
    calendar,
    fixtureCalendar,
    sheet,
    fixtureSheet,
  };

  if (store.listMerchants().length === 0) seed(instance);

  // Whatever the last process still owed the world -- a receipt after a
  // payment, a calendar entry -- is attempted now. See lib/outbox.ts.
  resumeOnBoot();
  return instance;
}

export function mercury(): Mercury {
  globalThis.__mercury__ ??= build();
  return globalThis.__mercury__;
}

export function railMode(): "fixture" | "live" {
  return mercury().fixture === undefined ? "live" : "fixture";
}

export function mailMode(): "fixture" | "live" {
  return mercury().fixtureMail === undefined ? "live" : "fixture";
}

export function chatMode(): "fixture" | "live" {
  return mercury().fixtureChat === undefined ? "live" : "fixture";
}

export function calendarMode(): "fixture" | "live" {
  return mercury().fixtureCalendar === undefined ? "live" : "fixture";
}

export function sheetsMode(): "fixture" | "live" {
  return mercury().fixtureSheet === undefined ? "live" : "fixture";
}

/**
 * GOOGLE_SERVICE_ACCOUNT_JSON is either the JSON itself or a path to the file
 * Google hands out. A path is easier to keep out of a shell history.
 */
function readServiceAccount(value: string): ServiceAccount {
  if (value === "") return { client_email: "", private_key: "" };
  const text = value.trimStart().startsWith("{") ? value : readFileSync(anchored(value), "utf8");
  const parsed = JSON.parse(text) as Partial<ServiceAccount>;
  return {
    client_email: parsed.client_email ?? "",
    private_key: parsed.private_key ?? "",
    ...(parsed.token_uri === undefined ? {} : { token_uri: parsed.token_uri }),
  };
}

/**
 * Where the webhook secret came from, and whether there is one.
 *
 * The webhook route reports this instead of guessing. An unconfigured secret in
 * live mode makes *every* genuine delivery fail its HMAC, which looks exactly
 * like an attack in the logs; saying "not configured" out loud is the
 * difference between a five-minute fix and an afternoon.
 */
export function webhookSecretStatus(): {
  mode: "fixture" | "live";
  configured: boolean;
  source: "env" | "fixture-default" | "none";
} {
  const fromEnv = (process.env["STRIPE_WEBHOOK_SECRET"] ?? "") !== "";
  const mode = railMode();
  if (fromEnv) return { mode, configured: true, source: "env" };
  return mode === "fixture"
    ? { mode, configured: true, source: "fixture-default" }
    : { mode, configured: false, source: "none" };
}

/** Load merchants, catalogue, principals and mandates into an open database. */
export function seed(m: Mercury = mercury()): void {
  for (const merchant of ALL_MERCHANTS) m.store.putMerchant(merchant);
  for (const item of ALL_ITEMS) m.store.putItem(item);

  const principals = seedPrincipals();
  // Seeding mints fresh delegated keys, so any wallet a buyer was holding is
  // now stale. Rewrite it here or Reset silently breaks every signed request.
  writeWallet(principals, WALLET_PATH);

  for (const p of principals) {
    m.store.putPrincipal(p.principal_id, p.public_key);
    m.store.putMandate(p.mandate);
    m.ledger.append({
      actor: { type: "human", id: p.principal_id },
      event_type: "MANDATE_ISSUED",
      ts: new Date().toISOString(),
      delegation_scope: {
        mandate_id: p.mandate.mandate.mandate_id,
        scope_hash: hashValue(p.mandate.mandate.scope),
      },
      envelope: {
        reserved_cents: p.mandate.mandate.reserved_cents,
        consumed_cents: 0,
        remaining_cents: p.mandate.mandate.reserved_cents,
      },
      detail: {
        vertical: p.mandate.mandate.vertical,
        human_present: p.mandate.mandate.human_present,
        max_per_txn_cents: p.mandate.mandate.max_per_txn_cents,
      },
    });
  }
  m.store.setFrozen(false);
}

/**
 * Wipe and re-seed.
 *
 * Deliberately destroys the file rather than truncating tables: The ledger is
 * append-only, so "clear the ledger" is not an operation it offers, and it
 * should not start offering one just because a demo wants a reset button.
 */
export function reset(): void {
  stopOutbox();
  const existing = globalThis.__mercury__;
  if (existing !== undefined) {
    existing.ledger.close();
    existing.store.close();
    globalThis.__mercury__ = undefined;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_PATH}${suffix}`, { force: true });
  }
  mercury();
}
