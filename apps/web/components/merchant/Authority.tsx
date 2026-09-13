"use client";

import { envelopeLabel } from "@/components/ui/EnvelopeMeter";
import { dollars } from "@/lib/format";
import type { EnvelopeView } from "@/lib/types";

/**
 * Why a sale can still be refused after everything the merchant permitted.
 *
 * This is the merchant looking at somebody else's budget, which sounds odd
 * until you remember the merchant is the one who has to refuse when it runs
 * out. Framing it as authority-remaining made it a statistic; framing it as the
 * reason a sale gets declined makes it the answer to a question a merchant
 * actually asks.
 *
 * Both limits bind independently, and the gate stops on whichever runs out
 * first -- which is why the debit count is printed as prominently as the money.
 */
export function Authority({ envelopes }: { envelopes: EnvelopeView[] }) {
  return (
    <section className="flex min-h-0 flex-col">
      <span className="eyebrow text-brass">Why a sale can still be refused</span>

      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
        {envelopes.length === 0 ? (
          <p className="text-[13px] text-paper-faint">No live budgets. Try Reset.</p>
        ) : (
          envelopes.map((e) => {
            const used =
              e.reserved_cents === 0
                ? 0
                : Math.min(100, (e.consumed_cents / e.reserved_cents) * 100);
            const ordersLeft = Math.max(0, e.max_txn_count - e.txn_count);

            return (
              <div key={e.mandate_id} className="min-w-0">
                <span className="eyebrow truncate">{envelopeLabel(e.mandate_id)}</span>

                <div className="mt-2 h-[5px] w-full bg-ink-sunk ring-1 ring-rule">
                  <div
                    className="h-full bg-brass transition-[width] duration-500 ease-out"
                    style={{ width: `${used}%` }}
                  />
                </div>

                <p className="mt-2.5 text-[13.5px] leading-relaxed text-paper-dim">
                  This buyer may spend{" "}
                  <span className="figures text-paper">{dollars(e.remaining_cents)}</span> more
                  here, across{" "}
                  <span className="figures text-paper">{ordersLeft}</span>{" "}
                  {ordersLeft === 1 ? "more order" : "more orders"}.
                </p>
              </div>
            );
          })
        )}
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-paper-faint">
        Either can run out first. A budget with dollars left but no orders left is
        spent, and <span className="hash">MANDATE.VELOCITY</span> is what says so.
      </p>
    </section>
  );
}
