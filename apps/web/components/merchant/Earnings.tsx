"use client";

import { bps, dollars } from "@/lib/format";
import type { MerchantSummary } from "@/lib/types";

/**
 * What the agent earned, as the screen's headline rather than one figure among
 * several.
 *
 * A merchant arrives with one question. The old panel answered it in a corner
 * cell the same size as the two figures beside it; this answers it in a
 * sentence you read before anything else, with the evidence underneath.
 *
 * Three states, and the honest ones matter most:
 *   nothing negotiated  -- say so plainly, do not print a zero
 *   negotiated, no gain -- the agent did not beat a price list, and says so
 *   negotiated, a gain  -- the number, large
 *
 * A design that could only render the third would be a brochure.
 */

const LEVER_LABEL: Record<string, { name: string; how: string }> = {
  bulk_tier: {
    name: "bulk pricing",
    how: "moved a buyer up the quantity ladder to a better unit price",
  },
  bundle: {
    name: "bundling",
    how: "added an item the buyer invited, shipping in the same trip",
  },
  substitute: {
    name: "substitution",
    how: "filled a short line with the nearest stocked equivalent",
  },
  credit_terms: { name: "credit terms", how: "discussed terms without pricing them" },
};

export function Earnings({ summary }: { summary: MerchantSummary | null }) {
  const baskets = summary?.baskets ?? 0;
  const uplift = summary?.uplift_cents ?? 0;
  const levers = summary?.levers ?? [];

  const tone = uplift > 0 ? "text-brass" : uplift < 0 ? "text-vermilion" : "text-paper-faint";

  const headline =
    baskets === 0
      ? { lead: "Your agent has not", figure: "negotiated yet.", tail: "" }
      : uplift > 0
        ? {
            lead: "Your agent earned you",
            figure: `+${dollars(uplift)}`,
            tail: "more than a price list would have.",
          }
        : uplift < 0
          ? {
              lead: "Your agent has cost you",
              figure: dollars(Math.abs(uplift)),
              tail: "against a plain price list.",
            }
          : { lead: "Your agent has not yet beaten", figure: "a price list.", tail: "" };

  return (
    <section>
      <div className="flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          <p className="display text-[26px] leading-[1.24] text-paper sm:text-[30px]">
            {headline.lead}
          </p>
          <p
            className={`display-figure mt-0.5 text-[64px] sm:text-[84px] xl:text-[98px] ${tone}`}
          >
            {headline.figure}
          </p>
          {headline.tail === "" ? null : (
            <p className="display mt-1.5 text-[26px] leading-[1.24] text-paper sm:text-[30px]">
              {headline.tail}
            </p>
          )}
        </div>

        {/* The two figures the claim rests on. Subordinate, and never absent. */}
        <div className="flex shrink-0 items-baseline gap-8 pb-2 sm:gap-9">
          <div>
            <span className="eyebrow">Buyer asked</span>
            <p className="figures mt-1.5 text-[19px] text-paper-dim">
              {baskets === 0 ? "—" : dollars(summary?.baseline_cents ?? 0)}
            </p>
          </div>
          <span className="display text-[19px] text-rule-bright">&rarr;</span>
          <div>
            <span className="eyebrow">the gate approved</span>
            <p className="figures mt-1.5 text-[19px] text-paper">
              {baskets === 0 ? "—" : dollars(summary?.final_cents ?? 0)}
            </p>
          </div>
          <div className="text-right">
            <span className="eyebrow">Uplift</span>
            <p className={`display-figure mt-1.5 text-[19px] ${tone}`}>
              {baskets === 0 ? "—" : bps(summary?.uplift_bps ?? 0, { sign: true })}
            </p>
          </div>
        </div>
      </div>

      {/* How, in the merchant's words rather than the lever's identifier. */}
      <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-2 border-t border-rule pt-4">
        {baskets === 0 ? (
          <p className="text-[14px] text-paper-faint">
            Run a scenario in Mission Control and the figures land here.
          </p>
        ) : levers.length === 0 ? (
          <p className="text-[14px] text-paper-dim">
            No lever was pulled — whatever changed came from volume the buyer chose.
          </p>
        ) : (
          <p className="min-w-0 text-[14px] leading-relaxed text-paper-dim">
            It did it with{" "}
            {levers.map((l, i) => (
              <span key={l.lever}>
                {i > 0 ? (i === levers.length - 1 ? " and " : ", ") : ""}
                <span className="text-brass">{LEVER_LABEL[l.lever]?.name ?? l.lever}</span>
                <span className="figures text-paper-faint">
                  {" "}
                  {l.uplift_cents > 0 ? "+" : ""}
                  {dollars(l.uplift_cents)}
                </span>
              </span>
            ))}
            <span className="text-paper-faint">
              {" — "}
              {LEVER_LABEL[levers[0]?.lever ?? ""]?.how ?? "on the baskets it negotiated"}.
            </span>
          </p>
        )}

        <span className="ml-auto flex shrink-0 items-baseline gap-4">
          <span className="figures text-[11.5px] text-paper-faint">
            {baskets} {baskets === 1 ? "basket" : "baskets"}
          </span>
        </span>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-paper-faint">
        Summed from <span className="hash">BASKET_VALUED</span> entries in the
        chain, not from a counter we keep — so it is the same figure an outside
        party reaches by walking the ledger.
        {levers.length > 1
          ? " A basket that used two levers splits its uplift between them; the gate priced the cart, not each lever's share of it."
          : ""}
      </p>
    </section>
  );
}
