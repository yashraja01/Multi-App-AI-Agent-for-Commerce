"use client";

import { useMemo, useState } from "react";
import { clockTime, dollars } from "@/lib/format";
import type { BusEvent, StateView } from "@/lib/types";

/**
 * Across your apps.
 *
 * The one panel the two-minute demo is built around. On the left, the email
 * a café manager would send. On the right, the run drawn as a single ruled
 * line with seven stations -- the inbox, the two agents, the gate, Stripe, the
 * calendar, the team's channel, the receipt -- each lighting up with a time
 * and one line of result as the real event lands. It is designed to be watched
 * in silence for ten seconds.
 *
 * Nothing here decides anything. The stations are read off the run bus; the
 * bus is fed by the same code path a terminal or an MCP client would drive.
 */

export type StationId = "inbox" | "agent" | "gate" | "stripe" | "calendar" | "sheets" | "slack" | "receipt";

export interface Station {
  id: StationId;
  app: string;
  /** What this station does, in the words of the person watching. */
  job: string;
  state: "idle" | "waiting" | "done" | "warn" | "fail" | "owed";
  detail: string;
  at?: string;
}

const BLANK: Station[] = [
  { id: "inbox", app: "Gmail", job: "reads the request", state: "idle", detail: "" },
  { id: "agent", app: "Supplier's agent", job: "haggles", state: "idle", detail: "" },
  { id: "gate", app: "The gate", job: "re-prices and checks the budget", state: "idle", detail: "" },
  { id: "stripe", app: "Stripe", job: "takes the payment", state: "idle", detail: "" },
  { id: "calendar", app: "Google Calendar", job: "books the delivery", state: "idle", detail: "" },
  { id: "sheets", app: "Google Sheets", job: "logs the purchase", state: "idle", detail: "" },
  { id: "slack", app: "Slack", job: "tells the team", state: "idle", detail: "" },
  { id: "receipt", app: "Gmail", job: "sends the receipt", state: "idle", detail: "" },
];

/**
 * Fold one run's events into seven stations.
 *
 * Pure, so the strip is a function of the bus and nothing else. Later events
 * overwrite earlier ones for the same station -- a retry that succeeds
 * replaces the warning it followed.
 */
export function stationsOf(run: BusEvent[]): Station[] {
  const s = BLANK.map((b) => ({ ...b }));
  const at = (id: StationId): Station => s.find((x) => x.id === id) as Station;
  let held = false;

  for (const { ts, event: e } of run) {
    switch (e.type) {
      case "note":
        if (e.text.startsWith("Email from ")) {
          const subject = /"([^"]*)"$/u.exec(e.text)?.[1] ?? "";
          Object.assign(at("inbox"), { state: "done", detail: subject === "" ? "request received" : `"${subject}"`, at: ts });
        } else if (e.text.startsWith("Crash drill")) {
          held = true;
          for (const id of ["calendar", "sheets", "slack", "receipt"] as const) {
            if (at(id).state === "idle") Object.assign(at(id), { state: "owed", detail: "owed — the process died here", at: ts });
          }
        }
        break;
      case "buyer":
        if (at("inbox").state === "idle") Object.assign(at("inbox"), { state: "done", detail: "request read", at: ts });
        Object.assign(at("agent"), { state: "waiting", detail: "reading the request…", at: ts });
        break;
      case "offer":
        Object.assign(at("agent"), {
          state: "done",
          detail: `offer ${e.round}: ${dollars(e.quoted_cents)} for ${e.lines.reduce((n, l) => n + l.qty, 0)} items`,
          at: ts,
        });
        Object.assign(at("gate"), { state: "waiting", detail: "re-pricing…", at: ts });
        break;
      case "verdict": {
        const computed = e.computed_cents === undefined ? "" : ` · computed ${dollars(e.computed_cents)}`;
        if (e.outcome === "DENY") {
          Object.assign(at("gate"), { state: "fail", detail: `refused${computed}`, at: ts });
        } else if (e.outcome === "ALLOW_WITH_STEPUP") {
          Object.assign(at("gate"), { state: "warn", detail: `needs a human${computed}`, at: ts });
        } else {
          Object.assign(at("gate"), { state: "done", detail: `approved${computed}`, at: ts });
        }
        break;
      }
      case "stepup":
        Object.assign(at("stripe"), { state: "warn", detail: "nothing charged — waiting for the owner", at: ts });
        break;
      case "payment":
        if (e.status === "captured") Object.assign(at("stripe"), { state: "done", detail: "authorised, then captured", at: ts });
        else if (e.status === "failed") Object.assign(at("stripe"), { state: "warn", detail: e.detail, at: ts });
        else Object.assign(at("stripe"), { state: "fail", detail: e.detail, at: ts });
        break;
      case "app": {
        const id: StationId =
          e.app === "google_calendar" ? "calendar" : e.app === "google_sheets" ? "sheets" : e.app === "slack" ? "slack" : "receipt";
        const retrying = !e.ok && /retrying/u.test(e.detail);
        Object.assign(at(id), {
          state: e.ok ? "done" : retrying ? "warn" : "fail",
          detail: e.detail,
          at: ts,
        });
        break;
      }
      case "done":
        // A run that ended without touching an app station: that station did
        // not apply (a denial books no delivery). Say so rather than leave it
        // looking unfinished.
        for (const id of ["stripe", "calendar", "sheets", "slack", "receipt"] as const) {
          if (at(id).state === "idle" && !held) Object.assign(at(id), { detail: "—" });
        }
        break;
      default:
        break;
    }
  }
  return s;
}

/* -------------------------------------------------------------- the strip --- */

const DOT: Record<Station["state"], string> = {
  idle: "border-rule bg-ink",
  waiting: "border-brass bg-ink pulse-freeze",
  done: "border-paper bg-paper",
  warn: "border-brass bg-brass",
  fail: "border-vermilion bg-vermilion",
  owed: "border-brass border-dashed bg-ink",
};

const TEXT: Record<Station["state"], string> = {
  idle: "text-paper-faint",
  waiting: "text-paper-dim",
  done: "text-paper",
  warn: "text-brass",
  fail: "text-vermilion",
  owed: "text-brass",
};

function Strip({ stations }: { stations: Station[] }) {
  return (
    <ol className="relative grid grid-cols-8 gap-x-2 pt-1" aria-label="The run, app by app">
      {/* The ruled line the stations sit on. Segments fill as the run advances. */}
      <div className="pointer-events-none absolute left-[6.25%] right-[6.25%] top-[9px] h-px bg-rule" aria-hidden />
      {stations.map((st, i) => {
        const next = stations[i + 1];
        const reached = st.state !== "idle" && st.state !== "owed";
        const filled = reached && next !== undefined && next.state !== "idle" && next.state !== "owed";
        return (
          <li key={st.id} className="relative min-w-0">
            {filled ? (
              <div className="pointer-events-none absolute left-1/2 top-[9px] h-px w-full bg-paper-dim" aria-hidden />
            ) : null}
            <div className="flex flex-col items-center text-center">
              <span
                className={`relative z-10 block h-[10px] w-[10px] rounded-full border ${DOT[st.state]} ${
                  reached ? "settle-in" : ""
                }`}
                aria-hidden
              />
              <span className="mt-2.5 text-[12px] leading-tight text-paper">{st.app}</span>
              <span className="text-[11px] leading-tight text-paper-faint">{st.job}</span>
              <span
                className={`mt-2 line-clamp-2 min-h-[2.6em] px-1 text-[12px] leading-snug ${TEXT[st.state]}`}
                title={st.detail}
              >
                {st.detail === "" ? " " : st.detail}
              </span>
              <span className="figures mt-1 text-[10px] text-paper-faint">{st.at === undefined ? " " : clockTime(st.at)}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ----------------------------------------------------------- the composer --- */

export interface Drills {
  bounce_receipt: boolean;
  fail_chat: boolean;
  fail_calendar: boolean;
  fail_sheet: boolean;
  crash_after_payment: boolean;
}

const DEMO_EMAIL = {
  from: "manager@harborstreetcafe.test",
  subject: "Restock for next week",
  text: "Hi — restock for next week please: 10 bags of coffee beans and 6 cases of oat milk. Thanks!",
};

export function AcrossApps({
  state,
  run,
  running,
  mode,
  onSend,
  onRestart,
}: {
  state: StateView | null;
  /** The bus events of the run being shown. */
  run: BusEvent[];
  running: boolean;
  mode: "scripted" | "llm";
  onSend: (email: { from: string; subject: string; text: string }, drills: Drills) => void;
  onRestart: () => void;
}) {
  const [from, setFrom] = useState(DEMO_EMAIL.from);
  const [subject, setSubject] = useState(DEMO_EMAIL.subject);
  const [text, setText] = useState(DEMO_EMAIL.text);
  const [drills, setDrills] = useState<Drills>({
    bounce_receipt: false,
    fail_chat: false,
    fail_calendar: false,
    fail_sheet: false,
    crash_after_payment: false,
  });
  const [showDrills, setShowDrills] = useState(false);

  const stations = useMemo(() => stationsOf(run), [run]);
  const held = stations.some((s) => s.state === "owed");
  const business = state?.business.name ?? "the café";
  const address = state?.apps.address ?? "";

  const live = (m: "fixture" | "live" | undefined): string => (m === "live" ? "live" : "recorded");

  return (
    <section className="panel">
      <div className="panel-head flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-3">
        <h2 className="display text-[15px] text-paper">One email, five apps</h2>
        <span className="text-[11px] text-paper-faint">
          Gmail {live(state?.apps.mail)} · Stripe {live(state?.rail_mode)} · Google Calendar {live(state?.apps.calendar)} · Google
          Sheets {live(state?.apps.sheets)} · Slack {live(state?.apps.chat)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-6 px-4 py-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,5fr)]">
        {/* The letter. Underlined fields, not boxes: it should read as writing an email, not filling in a form. */}
        <form
          className="flex flex-col gap-3"
          onSubmit={(ev) => {
            ev.preventDefault();
            onSend({ from, subject, text }, drills);
          }}
        >
          <p className="text-[13px] leading-snug text-paper-dim">
            Write to {business}&apos;s purchasing agent{address === "" ? "" : <> at <span className="figures text-paper">{address}</span></>}.
            It can only buy what you name, only within the budget the owner signed.
          </p>
          <label className="flex items-baseline gap-3 text-[12px]">
            <span className="w-14 shrink-0 text-paper-faint">From</span>
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              disabled={running}
              className="instruction-value w-full text-left text-[12px]"
              autoComplete="off"
            />
          </label>
          <label className="flex items-baseline gap-3 text-[12px]">
            <span className="w-14 shrink-0 text-paper-faint">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={running}
              className="instruction-value w-full text-left text-[12px]"
              autoComplete="off"
            />
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={running}
            rows={3}
            className="w-full resize-none border border-rule bg-ink-sunk px-3 py-2 text-[13px] leading-relaxed text-paper outline-none focus:border-brass disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={running || text.trim() === ""}
              className="border border-brass bg-brass/15 px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-brass transition-colors hover:bg-brass/25 disabled:opacity-40"
            >
              {running ? "Working…" : "Send"}
            </button>
            <button
              type="button"
              onClick={() => setShowDrills((v) => !v)}
              aria-pressed={showDrills}
              className="text-[11px] text-paper-faint underline-offset-2 hover:text-paper-dim hover:underline"
            >
              {showDrills ? "hide the failure drills" : "break something on purpose"}
            </button>
            {mode === "llm" ? <span className="text-[11px] text-paper-faint">Claude is haggling for the supplier</span> : null}
          </div>
          {showDrills ? (
            <fieldset className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-rule pt-3 text-[12px] text-paper-dim">
              <legend className="sr-only">Failure drills</legend>
              {(
                [
                  ["bounce_receipt", "the receipt bounces"],
                  ["fail_chat", "Slack is down"],
                  ["fail_calendar", "the calendar fails once"],
                  ["fail_sheet", "the purchase log fails once"],
                  ["crash_after_payment", "the process dies after paying"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={drills[key]}
                    disabled={running}
                    onChange={(e) => setDrills((d) => ({ ...d, [key]: e.target.checked }))}
                    className="accent-[var(--color-brass)]"
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          ) : null}
        </form>

        <div className="flex min-w-0 flex-col">
          <div className="flex flex-1 items-center py-2">
            <div className="w-full">
              <Strip stations={stations} />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3">
            <span className="text-[11px] text-paper-faint">
              {state === null
                ? ""
                : `Outbox: ${state.outbox.pending} owed · ${state.outbox.done} done${
                    state.outbox.failed > 0 ? ` · ${state.outbox.failed} failed` : ""
                  }`}
            </span>
            {held ? (
              <button
                type="button"
                onClick={onRestart}
                className="border border-brass px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-brass transition-colors hover:bg-brass/15"
              >
                Restart the process
              </button>
            ) : (
              <span className="text-[11px] text-paper-faint">
                Every step is one line in the ledger. A failed app never touches the payment.
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
