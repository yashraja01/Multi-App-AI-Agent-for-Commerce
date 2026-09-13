"use client";

import { useEffect, useRef } from "react";
import { dollars } from "@/lib/format";
import { TabStrip } from "./ui/TabStrip";
import type { ScenarioView, TheatreEvent } from "@/lib/types";

/**
 * The Negotiation Theatre.
 *
 * A transcript, not a chat: every line is either something an agent said or
 * something the gate did, and the two are visually distinct on purpose. An
 * agent's speech is prose; a verdict is an instrument reading.
 */

const OUTCOME_STYLE: Record<string, { border: string; text: string; label: string }> = {
  ALLOW: { border: "border-verdigris", text: "text-verdigris", label: "Allow" },
  ALLOW_WITH_STEPUP: { border: "border-brass", text: "text-brass", label: "Allow · step-up" },
  DENY: { border: "border-vermilion", text: "text-vermilion", label: "Deny" },
};

function Speech({ who, text }: { who: "buyer" | "merchant"; text: string }) {
  const isBuyer = who === "buyer";
  return (
    <div className={`settle-in flex gap-3 ${isBuyer ? "" : "flex-row-reverse"}`}>
      <span className="eyebrow mt-1 w-[68px] shrink-0 text-right">
        {isBuyer ? "buyer" : "merchant"}
      </span>
      <p
        className={`max-w-[46ch] border-l-2 px-3 py-1.5 text-[14px] leading-relaxed ${
          isBuyer
            ? "border-rule-bright text-paper-dim"
            : "border-brass-dim bg-brass/[0.04] text-paper"
        }`}
      >
        {text}
      </p>
    </div>
  );
}

function Offer({ event }: { event: Extract<TheatreEvent, { type: "offer" }> }) {
  return (
    <div className="settle-in ml-[80px] border border-rule bg-ink-sunk">
      <div className="flex items-baseline justify-between border-b border-rule px-3 py-1.5">
        <span className="eyebrow">Offer {event.round}</span>
        <span className="figures text-[11px] text-paper-faint">
          agent quotes {dollars(event.quoted_cents)}
        </span>
      </div>

      <table className="w-full text-[12px]">
        <tbody>
          {event.lines.map((l) => {
            const off = l.list_cents > 0 ? 1 - l.unit_cents / l.list_cents : 0;
            return (
              <tr key={l.sku} className="border-b border-rule/60 last:border-0">
                <td className="px-3 py-1.5 text-paper">{l.title}</td>
                <td className="figures px-2 py-1.5 text-right text-paper-dim">×{l.qty}</td>
                <td className="figures px-3 py-1.5 text-right text-paper">
                  {dollars(l.unit_cents)}
                  {off > 0.001 ? (
                    <span className="ml-2 text-[11px] text-brass">
                      −{(off * 100).toFixed(1)}%
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {event.rationale === "" ? null : (
        <p className="border-t border-rule px-3 py-1.5 text-[12px] italic text-paper-faint">
          {event.rationale}
        </p>
      )}
    </div>
  );
}

function Verdict({ event }: { event: Extract<TheatreEvent, { type: "verdict" }> }) {
  const style = OUTCOME_STYLE[event.outcome] ?? OUTCOME_STYLE["DENY"]!;
  const failed = event.rules.filter((r) => !r.passed);

  return (
    <div className={`settle-in verdict-flash ml-[80px] border ${style.border} bg-ink-sunk`}>
      <div className="flex items-baseline justify-between px-3 py-2">
        <span className="eyebrow text-[12px]">the gate</span>
        <span className={`display text-[14px] tracking-[0.06em] ${style.text}`}>
          {style.label}
        </span>
      </div>

      {failed.length > 0 ? (
        <ul className="border-t border-rule">
          {failed.map((r) => (
            <li key={r.rule_id} className="px-3 py-1.5 text-[12px]">
              <span className={`figures ${style.text}`}>{r.rule_id}</span>
              <span className="ml-2 text-paper-dim">{r.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Marker({
  tone,
  label,
  children,
}: {
  tone: "brass" | "verdigris" | "vermilion" | "quiet";
  label: string;
  children: React.ReactNode;
}) {
  const color =
    tone === "brass"
      ? "text-brass"
      : tone === "verdigris"
        ? "text-verdigris"
        : tone === "vermilion"
          ? "text-vermilion"
          : "text-paper-faint";

  return (
    <div className="settle-in ml-[80px] flex gap-3 text-[12px]">
      <span className={`figures shrink-0 uppercase tracking-[0.12em] ${color}`}>{label}</span>
      <span className="text-paper-dim">{children}</span>
    </div>
  );
}

const APP_LABEL = { gmail: "gmail", slack: "slack", google_calendar: "calendar", google_sheets: "sheets" } as const;

function EventRow({ event }: { event: TheatreEvent }) {
  switch (event.type) {
    case "buyer":
      return <Speech who="buyer" text={event.text} />;
    case "merchant":
      return <Speech who="merchant" text={event.text} />;
    case "offer":
      return <Offer event={event} />;
    case "verdict":
      return <Verdict event={event} />;
    case "order":
      return (
        <Marker tone="brass" label="order">
          {event.order_id} for {dollars(event.amount_cents)} — the amount the gate computed
        </Marker>
      );
    case "stepup":
      return (
        <Marker tone="brass" label="step-up">
          {event.reason.toLowerCase().replace(/_/gu, " ")} — approval link {event.link_url}
        </Marker>
      );
    case "payment":
      return (
        <Marker
          tone={
            event.status === "captured"
              ? "verdigris"
              : event.status === "failed"
                ? "vermilion"
                : "brass"
          }
          label={`${event.status} ${event.attempt}`}
        >
          {event.detail}
        </Marker>
      );
    case "split":
      return (
        <div className="settle-in ml-[80px] border border-verdigris-dim bg-verdigris/[0.04]">
          <div className="flex items-baseline justify-between border-b border-rule px-3 py-1.5">
            <span className="eyebrow">Route · split settlement</span>
            <span className="figures text-[11px] text-paper-faint">
              {dollars(event.captured_cents)} captured, paid out in {event.legs.length}
            </span>
          </div>
          <table className="w-full text-[12px]">
            <tbody>
              {event.legs.map((leg) => (
                <tr key={leg.account} className="border-b border-rule/60 last:border-0">
                  <td className="figures px-3 py-1.5 text-paper-dim">{leg.account}</td>
                  <td className="figures px-3 py-1.5 text-right text-verdigris">
                    {dollars(leg.amount_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-rule px-3 py-1.5 text-[11px] text-paper-faint">
            Commission {dollars(event.commission_cents)} off the top; the rest divided by what each
            supplier sold. The legs sum to the capture exactly.
          </p>
        </div>
      );
    case "note":
      return (
        <Marker tone="quiet" label="·">
          {event.text}
        </Marker>
      );
    case "app":
      return (
        <Marker tone={event.ok ? "verdigris" : "vermilion"} label={APP_LABEL[event.app]}>
          {event.detail}
        </Marker>
      );
    case "done":
      return null;
    default:
      return null;
  }
}

export function Theatre({
  scenarios,
  selected,
  onSelect,
  mode,
  onMode,
  llmAvailable,
  events,
  running,
  onRun,
}: {
  scenarios: ScenarioView[];
  selected: string;
  onSelect: (id: string) => void;
  mode: "scripted" | "llm";
  onMode: (m: "scripted" | "llm") => void;
  llmAvailable: boolean;
  events: TheatreEvent[];
  running: boolean;
  onRun: () => void;
}) {
  const tail = useRef<HTMLDivElement>(null);
  const scenario = scenarios.find((s) => s.id === selected);

  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  return (
    <section className="panel flex min-h-0 flex-1 flex-col">
      <div className="panel-head flex items-baseline justify-between px-4 py-3">
        <h2 className="display text-[15px] text-paper">Watch a purchase happen</h2>
        <span className="eyebrow">{running ? "running" : "pick one and press run"}</span>
      </div>

      {/* Scenario bench. Each chip is a situation the gate has to survive. */}
      <div className="border-b border-rule px-4 py-3">
        <span className="eyebrow">Situations</span>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {scenarios.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              disabled={running}
              className={`border px-2.5 py-1.5 text-[12px] transition-colors disabled:opacity-50 ${
                s.id === selected
                  ? "border-brass bg-brass/10 text-paper"
                  : "border-rule text-paper-dim hover:border-rule-bright hover:text-paper"
              }`}
            >
              {s.label}
              {s.failure === null ? null : (
                <span className="figures ml-1.5 text-[10px] text-vermilion">{s.failure}</span>
              )}
            </button>
          ))}
        </div>

        {scenario === undefined ? null : (
          <p className="mt-3 max-w-[78ch] text-[13px] leading-relaxed text-paper-dim">
            {scenario.premise}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onRun}
            disabled={running}
            className="border border-brass bg-brass/15 px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-brass transition-colors hover:bg-brass/25 disabled:opacity-40"
          >
            {running ? "Negotiating…" : "Run it"}
          </button>

          <span className="flex items-center gap-2">
            <span className="eyebrow">Seller is</span>
            <TabStrip
              size="sm"
              value={mode}
              onChange={onMode}
              disabled={running}
              tabs={[
                {
                  id: "scripted",
                  label: "Scripted",
                  title: "A deterministic stand-in. No API key, no network, no spend.",
                },
                {
                  id: "llm",
                  label: "Claude",
                  disabled: !llmAvailable,
                  title: llmAvailable
                    ? "Claude negotiates through the same tools and the same gate."
                    : "Set ANTHROPIC_API_KEY to let Claude make the offers",
                },
              ]}
            />
          </span>
        </div>
      </div>

      <div className="ruled min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {events.length === 0 ? (
          <p className="mt-8 text-center text-[13px] text-paper-faint">
            Pick a scenario and run it. Nothing has been proposed yet.
          </p>
        ) : (
          events.map((e, i) => <EventRow key={i} event={e} />)
        )}
        <div ref={tail} />
      </div>
    </section>
  );
}
