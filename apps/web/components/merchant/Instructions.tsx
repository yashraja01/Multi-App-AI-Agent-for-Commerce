"use client";

import { useEffect, useState } from "react";
import type { PolicyView } from "@/lib/types";

/**
 * What the merchant lets its agent do.
 *
 * Three groups, plainly named, and one kind of control per kind of question:
 *
 *   a slider   for a percentage, where the whole range is meaningful and the
 *              useful gesture is "a bit more, a bit less"
 *   a box      for a count or an amount, where you already know the number and
 *              dragging to 1,50,000 would be absurd
 *   a toggle   for a permission, which is on or off
 *
 * That mapping is the whole legibility argument: a viewer who has never seen
 * this should be able to tell what a control does from its shape, before
 * reading its label.
 *
 * Nothing here is advisory. Each control is a gate rule, and the gate refuses
 * a cart that breaks it. The rule id and the raw figure the gate reads sit
 * behind one toggle -- demoted, never deleted, because the determinism is the
 * reason to trust the simple version.
 */

const LEVERS = [
  {
    id: "bulk_tier",
    label: "Offer a better price for a bigger order",
    note: "a quantity ladder at 5 / 10 / 25 / 50 units",
  },
  {
    id: "substitute",
    label: "Suggest a stocked equivalent",
    note: "same category, when a line runs short",
  },
  {
    id: "bundle",
    label: "Add a complementary item",
    note: "only when the buyer invites it",
  },
  {
    id: "credit_terms",
    label: "Discuss credit terms",
    note: "may be discussed, never priced",
  },
] as const;

/* ------------------------------------------------------------- control shell */

function Shell({
  label,
  hint,
  value,
  rule,
  raw,
  modified,
  showProof,
  children,
}: {
  label: string;
  hint: string;
  /** The current setting, read as a word. Sits beside the label, always. */
  value: string;
  rule: string;
  raw: string;
  modified: boolean;
  showProof: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[14px] text-paper-dim">{label}</span>
        <span className="display-figure shrink-0 text-[21px] text-paper">
          {value}
          {modified ? <span className="ml-1.5 align-super text-[10px] text-brass">•</span> : null}
        </span>
      </div>

      <div className="mt-2.5">{children}</div>

      <p className="mt-2 text-[12px] leading-snug text-paper-faint">{hint}</p>

      {showProof ? (
        <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="hash text-brass-dim">{rule}</span>
          <span className="hash">{raw}</span>
        </p>
      ) : null}
    </div>
  );
}

/** A percentage. The range is the point, so it drags. */
function SliderControl(props: {
  label: string;
  hint: string;
  rule: string;
  raw: string;
  /** Basis points. */
  bps: number;
  maxBps: number;
  stepBps: number;
  modified: boolean;
  showProof: boolean;
  disabled: boolean;
  onChange: (bps: number) => void;
}) {
  const pct = Number((props.bps / 100).toFixed(2));

  return (
    <Shell
      label={props.label}
      hint={props.hint}
      value={`${pct}%`}
      rule={props.rule}
      raw={props.raw}
      modified={props.modified}
      showProof={props.showProof}
    >
      <input
        type="range"
        min={0}
        max={props.maxBps}
        step={props.stepBps}
        value={props.bps}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
        aria-label={props.label}
        className="w-full accent-[var(--color-brass)] disabled:opacity-40"
      />
    </Shell>
  );
}

/** A count or an amount. You know the number; type it. */
function NumberControl(props: {
  label: string;
  hint: string;
  rule: string;
  raw: string;
  value: number;
  max: number;
  step?: number;
  /** Rendered before the box, for money. */
  prefix?: string;
  /** Rendered after the value in the heading, e.g. "units". */
  unit?: string;
  modified: boolean;
  showProof: boolean;
  disabled: boolean;
  onChange: (n: number) => void;
}) {
  const shown =
    props.value === 0
      ? "no limit"
      : `${props.prefix ?? ""}${props.value.toLocaleString("en-US")}${props.unit === undefined ? "" : ` ${props.unit}`}`;

  return (
    <Shell
      label={props.label}
      hint={props.hint}
      value={shown}
      rule={props.rule}
      raw={props.raw}
      modified={props.modified}
      showProof={props.showProof}
    >
      <div className="flex items-center gap-2">
        {props.prefix === undefined ? null : (
          <span className="figures text-[14px] text-paper-faint">{props.prefix}</span>
        )}
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={props.max}
          step={props.step ?? 1}
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) props.onChange(Math.min(Math.max(Math.round(n), 0), props.max));
          }}
          aria-label={props.label}
          className="figures w-full border border-rule bg-ink-sunk px-3 py-2 text-[14px] text-paper transition-colors focus:border-brass focus:outline-none disabled:opacity-40"
        />
      </div>
    </Shell>
  );
}

/* ------------------------------------------------------------------ the board */

export interface InstructionPatch {
  max_discount_bps: number;
  levers: string[];
  commission_bps?: number;
  max_order_cents: number;
  max_order_units: number;
  max_order_lines: number;
  reserve_units: number;
  agent_categories: string[];
}

export function Instructions({
  policy,
  saving,
  disabled,
  onSave,
}: {
  policy: PolicyView | null;
  saving: boolean;
  disabled: boolean;
  onSave: (patch: InstructionPatch) => void;
}) {
  const [discount, setDiscount] = useState(0);
  const [commission, setCommission] = useState(0);
  const [maxOrder, setMaxOrder] = useState(0);
  const [maxUnits, setMaxUnits] = useState(0);
  const [maxLines, setMaxLines] = useState(0);
  const [reserve, setReserve] = useState(0);
  const [levers, setLevers] = useState<string[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [showProof, setShowProof] = useState(false);

  // The server is the source of truth; the form re-seeds whenever it speaks.
  useEffect(() => {
    if (policy === null) return;
    const p = policy.profile;
    setDiscount(p.max_discount_bps);
    setCommission(p.settlement?.commission_bps ?? 0);
    setMaxOrder(p.max_order_cents ?? 0);
    setMaxUnits(p.max_order_units ?? 0);
    setMaxLines(p.max_order_lines ?? 0);
    setReserve(p.reserve_units ?? 0);
    setLevers(p.levers);
    setCats(p.agent_categories ?? p.category_taxonomy);
  }, [policy]);

  if (policy === null) {
    return <div className="py-10 text-center text-[13px] text-paper-faint">Loading…</div>;
  }

  const p = policy.profile;
  const route = p.settlement;
  const was = (f: string): boolean => policy.modified.includes(f);
  const lock = disabled || saving;

  const sameSet = (a: string[], b: string[]): boolean =>
    [...a].sort().join(",") === [...b].sort().join(",");

  const dirty =
    discount !== p.max_discount_bps ||
    maxOrder !== (p.max_order_cents ?? 0) ||
    maxUnits !== (p.max_order_units ?? 0) ||
    maxLines !== (p.max_order_lines ?? 0) ||
    reserve !== (p.reserve_units ?? 0) ||
    !sameSet(levers, p.levers) ||
    !sameSet(cats, p.agent_categories ?? p.category_taxonomy) ||
    (route !== undefined && commission !== route.commission_bps);

  const toggle = (list: string[], set: (v: string[]) => void, id: string): void => {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="display text-[22px] text-paper">What your agent is allowed to do</h2>
        <div className="flex items-center gap-5">
          <span className="eyebrow">
            {policy.modified.length === 0
              ? "the gate refuses anything outside this"
              : `${policy.modified.length} changed from seed`}
          </span>
          <button
            type="button"
            onClick={() => setShowProof((v) => !v)}
            aria-pressed={showProof}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-brass-dim transition-colors hover:text-brass"
          >
            {showProof ? "hide the rules" : "why you can trust this"}
          </button>
        </div>
      </div>

      <div className="mt-7 grid min-h-0 flex-1 grid-cols-1 gap-x-12 gap-y-10 md:grid-cols-2 xl:grid-cols-3">
        {/* --------------------------------------------------------- pricing */}
        <div>
          <span className="eyebrow text-brass">Pricing</span>
          <div className="mt-5 flex flex-col gap-6">
            <SliderControl
              label="Biggest discount it may give"
              hint="off the list price, on any line"
              rule="DISCOUNT.BPS_CAP"
              raw={`max_discount_bps ${discount}`}
              bps={discount}
              maxBps={10_000}
              stepBps={50}
              modified={was("max_discount_bps")}
              showProof={showProof}
              disabled={lock}
              onChange={setDiscount}
            />

            {route === undefined ? null : (
              <SliderControl
                label="Platform's cut"
                hint={`taken off the top, before suppliers are paid`}
                rule="not read by the gate"
                raw={`settlement.commission_bps ${commission}`}
                bps={commission}
                maxBps={2_000}
                stepBps={25}
                modified={was("settlement.commission_bps")}
                showProof={showProof}
                disabled={lock}
                onChange={setCommission}
              />
            )}

            <NumberControl
              label="Biggest order it may close"
              hint="your own ceiling, separate from the buyer's budget. 0 means no limit"
              rule="ORDER.VALUE_CAP"
              raw={`max_order_cents ${maxOrder}`}
              value={Math.round(maxOrder / 100)}
              max={1_000_000}
              step={50}
              prefix="$"
              modified={was("max_order_cents")}
              showProof={showProof}
              disabled={lock}
              onChange={(n) => setMaxOrder(n * 100)}
            />
          </div>

          {showProof ? (
            <p className="mt-6 text-[11.5px] leading-relaxed text-paper-faint">
              Your margin floor is set on the profile and enforced as{" "}
              <span className="hash">MARGIN.FLOOR_BREACH</span>, but is not
              editable here — it is the one number where a slip sells below cost.
            </p>
          ) : null}
        </div>

        {/* -------------------------------------------------------- inventory */}
        <div>
          <span className="eyebrow text-brass">Inventory</span>

          <div className="mt-5">
            <span className="text-[14px] text-paper-dim">Categories it may sell</span>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {p.category_taxonomy.map((c) => {
                const live = cats.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    disabled={lock}
                    onClick={() => toggle(cats, setCats, c)}
                    aria-pressed={live}
                    className={`figures border px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40 ${
                      live
                        ? "border-brass bg-brass/15 text-paper"
                        : "border-rule text-paper-faint line-through hover:border-rule-bright"
                    }`}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[12px] leading-snug text-paper-faint">
              Tap to withdraw one. You can narrow this list, never widen it.
            </p>
            {showProof ? (
              <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3">
                <span className="hash text-brass-dim">SCOPE.MERCHANT_CATEGORIES</span>
                <span className="hash">agent_categories ⊆ category_taxonomy</span>
              </p>
            ) : null}
          </div>

          <div className="mt-6 flex flex-col gap-6">
            <NumberControl
              label="Stock always held back"
              hint="safety stock the agent can never sell into"
              rule="INVENTORY.RESERVE"
              raw={`reserve_units ${reserve}`}
              value={reserve}
              max={10_000}
              unit="units"
              modified={was("reserve_units")}
              showProof={showProof}
              disabled={lock}
              onChange={setReserve}
            />
            <NumberControl
              label="Most units in one order"
              hint="however large the buyer's budget is. 0 means no limit"
              rule="ORDER.UNIT_CAP"
              raw={`max_order_units ${maxUnits}`}
              value={maxUnits}
              max={100_000}
              unit="units"
              modified={was("max_order_units")}
              showProof={showProof}
              disabled={lock}
              onChange={setMaxUnits}
            />
            <NumberControl
              label="Most products in one order"
              hint="keeps a single cart pickable. 0 means no limit"
              rule="ORDER.LINE_CAP"
              raw={`max_order_lines ${maxLines}`}
              value={maxLines}
              max={500}
              unit="products"
              modified={was("max_order_lines")}
              showProof={showProof}
              disabled={lock}
              onChange={setMaxLines}
            />
          </div>
        </div>

        {/* ------------------------------------------------------ negotiation */}
        <div>
          <span className="eyebrow text-brass">Negotiation</span>
          <div className="mt-5 flex flex-col gap-4">
            {LEVERS.map((l) => {
              const on = levers.includes(l.id);
              return (
                <label
                  key={l.id}
                  className={`flex cursor-pointer items-start gap-3 ${lock ? "opacity-40" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={lock}
                    onChange={() => toggle(levers, setLevers, l.id)}
                    className="mt-[3px] h-[15px] w-[15px] shrink-0 accent-[var(--color-brass)]"
                  />
                  <span className="min-w-0">
                    <span
                      className={`block text-[14.5px] leading-[1.35] ${on ? "text-paper-dim" : "text-paper-faint"}`}
                    >
                      {l.label}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-paper-faint">{l.note}</span>
                  </span>
                </label>
              );
            })}
          </div>

          {was("levers") ? (
            <p className="mt-3 text-[11px] text-brass">Changed from the seeded profile.</p>
          ) : null}

          <p className="mt-6 text-[12px] leading-relaxed text-paper-faint">
            A tactic you do not permit is never used. That is how one
            implementation serves both of your shops.
          </p>

          {showProof ? (
            <p className="mt-4 text-[11.5px] leading-relaxed text-paper-faint">
              Not editable, on purpose: your identity, and the full category
              taxonomy. The taxonomy feeds{" "}
              <span className="hash">SCOPE.CATEGORY_ALLOWLIST</span>, so a form
              that could widen it would be a privilege escalation wearing a
              settings page.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-9 flex flex-wrap items-center justify-end gap-4 border-t border-rule pt-5">
        <span className="text-[12.5px] text-paper-faint">
          {dirty
            ? "Takes effect on the very next negotiation."
            : "Saved. The gate is reading this."}
        </span>
        <button
          type="button"
          disabled={!dirty || lock}
          onClick={() =>
            onSave({
              max_discount_bps: discount,
              levers,
              max_order_cents: maxOrder,
              max_order_units: maxUnits,
              max_order_lines: maxLines,
              reserve_units: reserve,
              agent_categories: cats,
              ...(route === undefined ? {} : { commission_bps: commission }),
            })
          }
          className="border border-brass bg-brass/15 px-6 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-brass transition-colors hover:bg-brass/25 disabled:border-rule disabled:bg-transparent disabled:text-paper-faint disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </section>
  );
}
