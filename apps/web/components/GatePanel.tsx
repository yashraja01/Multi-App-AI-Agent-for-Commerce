"use client";

import { useState } from "react";
import { centsExact, dollars } from "@/lib/format";
import type { TheatreEvent } from "@/lib/types";

/**
 * Gate, read as a sentence before it is read as an instrument.
 *
 * The whole product is two numbers: what the agent said the total was, and what
 * the gate computed it to be. Someone seeing this screen for the first time
 * should get that in one line, without knowing what a rule id is -- so the
 * plain reading leads, and the rule table sits behind the same "why you can
 * trust this" toggle the merchant console uses.
 *
 * The rule messages are deterministic templates from the gate. No model writes
 * anything on this panel.
 */

export function GatePanel({
  verdict,
}: {
  verdict: Extract<TheatreEvent, { type: "verdict" }> | null;
}) {
  const [showRules, setShowRules] = useState(false);

  const computed = verdict?.computed_cents;
  const quoted = verdict?.quoted_cents;
  const drifted = verdict !== null && computed !== undefined && quoted !== computed;
  const denied = verdict?.outcome === "DENY";
  const stepUp = verdict?.outcome === "ALLOW_WITH_STEPUP";

  const failed = (verdict?.rules ?? []).filter((r) => !r.passed);

  /* The one-line reading. Everything else on this panel supports it. */
  const headline =
    verdict === null
      ? "Nothing has reached the gate yet."
      : drifted
        ? "The agent's total did not match. Nothing was charged."
        : denied
          ? "The gate refused this cart."
          : stepUp
            ? "Allowed, but a human has to release it."
            : "Allowed. The gate charged its own figure.";

  const tone = denied || drifted ? "text-vermilion" : stepUp ? "text-brass" : "text-verdigris";

  return (
    <section className="panel flex min-h-0 flex-col">
      <div className="panel-head flex items-baseline justify-between gap-4 px-4 py-3">
        <h2 className="display text-[15px] text-paper">
          The gate
        </h2>
        <button
          type="button"
          onClick={() => setShowRules((v) => !v)}
          aria-pressed={showRules}
          disabled={verdict === null}
          className="font-mono text-[10px] uppercase tracking-[0.14em] text-brass-dim transition-colors hover:text-brass disabled:opacity-30"
        >
          {showRules ? "hide the rules" : "why you can trust this"}
        </button>
      </div>

      {/* The plain reading, first and largest. */}
      <div className="border-b border-rule px-4 py-4">
        <p className={`display text-[19px] leading-snug ${tone}`}>{headline}</p>

        <div className="mt-4 grid grid-cols-2 gap-px bg-rule">
          <div className="bg-ink px-3 py-3">
            <span className="eyebrow">The agent said</span>
            <p
              className={`figures mt-1.5 text-[19px] ${
                drifted ? "text-vermilion line-through decoration-vermilion/60" : "text-paper-dim"
              }`}
            >
              {quoted === undefined ? "—" : dollars(quoted)}
            </p>
            <p className="mt-1 text-[11px] text-paper-faint">never what gets charged</p>
          </div>

          <div className="bg-ink px-3 py-3">
            <span className="eyebrow">The gate charged</span>
            <p
              className={`display-figure mt-1.5 text-[19px] ${denied ? "text-paper-faint" : "text-brass"}`}
            >
              {computed === undefined ? "—" : dollars(computed)}
            </p>
            <p className="mt-1 text-[11px] text-paper-faint">
              {computed === undefined ? "no cart was priced" : "recomputed from the catalogue"}
            </p>
          </div>
        </div>

        {/* Why, in the buyer's words. The rule id is one toggle away. */}
        {verdict === null ? (
          <p className="mt-3 text-[12.5px] text-paper-faint">
            Pick a situation on the left and run it.
          </p>
        ) : drifted ? (
          <p className="mt-3 border border-vermilion-dim bg-vermilion/10 px-3 py-2 text-[12.5px] leading-relaxed text-vermilion">
            The agent&apos;s arithmetic was out by {centsExact(Math.abs((quoted ?? 0) - (computed ?? 0)))}.
            The size of the gap does not matter — any gap at all is refused.
          </p>
        ) : failed.length > 0 ? (
          <p className="mt-3 text-[12.5px] leading-relaxed text-paper-dim">
            {failed[0]?.message}
          </p>
        ) : (
          <p className="mt-3 text-[12.5px] leading-relaxed text-paper-dim">
            The agent&apos;s arithmetic matched — and the charge would have been
            the gate&apos;s figure either way.
          </p>
        )}
      </div>

      {/* The evidence, on request. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {verdict === null ? null : !showRules ? (
          <p className="px-4 py-3.5 text-[12px] leading-relaxed text-paper-faint">
            {verdict.rules.length} rules were checked before any money could move
            {failed.length > 0 ? `, and ${failed.length} failed` : ""}. Open{" "}
            <span className="text-brass-dim">why you can trust this</span> to see
            every one with its observed value and its limit.
          </p>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-ink">
              <tr className="border-b border-rule">
                <th className="eyebrow px-4 py-2 text-left font-normal">Rule</th>
                <th className="eyebrow px-2 py-2 text-right font-normal">Observed</th>
                <th className="eyebrow px-2 py-2 text-right font-normal">Limit</th>
                <th className="eyebrow px-4 py-2 text-right font-normal">·</th>
              </tr>
            </thead>
            <tbody>
              {/* Failures first. Nobody should scroll to find what stopped the money. */}
              {[...verdict.rules]
                .sort((a, b) => Number(a.passed) - Number(b.passed))
                .map((r) => (
                  <tr
                    key={r.rule_id}
                    className={`border-b border-rule/50 ${r.passed ? "" : "bg-vermilion/[0.07]"}`}
                    title={r.message}
                  >
                    <td
                      className={`figures px-4 py-2 ${r.passed ? "text-paper-dim" : "text-vermilion"}`}
                    >
                      {r.rule_id}
                    </td>
                    <td className="figures px-2 py-2 text-right text-paper">
                      {r.observed.toLocaleString("en-US")}
                    </td>
                    <td className="figures px-2 py-2 text-right text-paper-faint">
                      {r.limit.toLocaleString("en-US")}
                    </td>
                    <td
                      className={`px-4 py-2 text-right font-mono ${
                        r.passed ? "text-verdigris" : "text-vermilion"
                      }`}
                    >
                      {r.passed ? "pass" : "fail"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
