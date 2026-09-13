"use client";

import Link from "next/link";

import { EnvelopeMeter, envelopeLabel } from "@/components/ui/EnvelopeMeter";
import { Pill } from "@/components/ui/Pill";
import type { StateView } from "@/lib/types";

/**
 * The board's top rail: where you are, what mode we are in, what authority is
 * left, and the one control that stops everything.
 *
 * Shared by both pages. Mission Control watches the gate decide; the merchant
 * console owns the policy it decides by. Rail mode, envelopes, Reset and Freeze
 * belong to both, so they live here rather than in either page.
 */

const PAGES = [
  { href: "/", id: "mission", label: "Mission Control" },
  { href: "/merchant", id: "merchant", label: "Merchant" },
] as const;

export type PageId = (typeof PAGES)[number]["id"];

export function Header({
  state,
  busy,
  onFreeze,
  onReset,
  current,
}: {
  state: StateView | null;
  busy: boolean;
  onFreeze: (frozen: boolean) => void;
  onReset: () => void;
  current: PageId;
}) {
  const frozen = state?.frozen ?? false;

  return (
    <header className="border-b border-rule bg-ink-sunk">
      <div className="mx-auto flex max-w-[1680px] flex-col gap-5 px-6 py-4 xl:flex-row xl:items-center xl:gap-10">
        <div className="flex items-center gap-5">
          <div>
            <h1 className="display text-[22px] tracking-[0.22em] text-paper">
              MERCURY
            </h1>
            <p className="mt-0.5 text-[12px] leading-snug text-paper-dim">
              Two agents negotiate. A gate decides whether a dollar may move.
            </p>
          </div>

          <Pill
            size="md"
            className={
              state?.rail_mode === "live"
                ? "border-vermilion-dim text-vermilion"
                : "border-rule-bright text-paper-dim"
            }
            title={
              state?.rail_mode === "live"
                ? "Live Stripe test keys"
                : "Recorded Stripe shapes. No network."
            }
          >
            rail: {state?.rail_mode ?? "..."}
          </Pill>

          {/* Two seats at the same system: the observer's, and the merchant's. */}
          <nav className="flex items-center gap-1 border border-rule p-0.5">
            {PAGES.map((p) => (
              <Link
                key={p.id}
                href={p.href}
                aria-current={current === p.id ? "page" : undefined}
                className={`px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors ${
                  current === p.id
                    ? "bg-rule text-paper"
                    : "text-paper-faint hover:text-paper-dim"
                }`}
              >
                {p.label}
              </Link>
            ))}
          </nav>
        </div>

        {/*
          * The meters belong to the observer's seat. The merchant console shows
          * the same budgets under "why a sale can still be refused", where they
          * answer a question the merchant actually has -- printing them twice on
          * one page would make neither copy the authoritative one.
          */}
        <div className="flex min-w-0 flex-1 flex-col gap-5 sm:flex-row">
          {current === "merchant"
            ? null
            : (state?.envelopes ?? []).map((e) => (
                <EnvelopeMeter
                  key={e.mandate_id}
                  envelope={e}
                  label={envelopeLabel(e.mandate_id)}
                />
              ))}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onReset}
            disabled={busy}
            className="border border-rule-bright px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-paper-dim transition-colors hover:border-paper-faint hover:text-paper disabled:opacity-40"
          >
            Reset
          </button>

          {/* The kill switch. CIRCUIT.FROZEN is the first rule the gate checks, so
              this takes effect on the very next evaluation. */}
          <button
            type="button"
            onClick={() => onFreeze(!frozen)}
            aria-pressed={frozen}
            className={`border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
              frozen
                ? "pulse-freeze border-vermilion bg-vermilion/15 text-vermilion"
                : "border-vermilion-dim text-vermilion hover:bg-vermilion/10"
            }`}
          >
            {frozen ? "Frozen — unfreeze" : "Freeze all spend"}
          </button>
        </div>
      </div>

      {frozen ? (
        <div className="border-t border-vermilion-dim bg-vermilion/10 px-6 py-2 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-vermilion">
          Spend is frozen. Every proposal now fails on CIRCUIT.FROZEN, whatever it contains.
        </div>
      ) : null}
    </header>
  );
}
