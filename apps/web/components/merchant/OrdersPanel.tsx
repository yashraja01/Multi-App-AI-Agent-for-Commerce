"use client";

import { useState } from "react";
import { Pill } from "@/components/ui/Pill";
import { clockTime, dollars } from "@/lib/format";
import type { OrderView } from "@/lib/types";

/**
 * What the agent actually sold.
 *
 * One status is foregrounded, not two. The order status is ours and the payment
 * status is Stripe's, and they advance independently on webhooks that arrive
 * late, out of order or twice (F5) -- but a row reading `created / captured` is
 * a question a merchant should be able to opt into, not the first thing they
 * have to parse. The split is one toggle away and labelled, which is where an
 * FSM detail belongs on a screen whose job is to be understood.
 */

const PAYMENT_TONE: Record<string, string> = {
  captured: "border-verdigris text-verdigris",
  authorized: "border-brass text-brass",
  failed: "border-vermilion text-vermilion",
  refunded: "border-verdigris-dim text-verdigris",
  created: "border-rule text-paper-faint",
};

/** What a merchant calls it, rather than what the rail calls it. */
const PLAIN: Record<string, string> = {
  captured: "paid",
  authorized: "authorised",
  failed: "failed",
  refunded: "refunded",
  created: "pending",
};

export function OrdersPanel({ orders }: { orders: OrderView[] }) {
  const [split, setSplit] = useState(false);

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex items-baseline justify-between gap-4">
        <span className="eyebrow text-brass">What it sold</span>
        <div className="flex items-baseline gap-4">
          <span className="eyebrow">
            {orders.length === 0 ? "none yet" : `${orders.length} most recent`}
          </span>
          {orders.length === 0 ? null : (
            <button
              type="button"
              onClick={() => setSplit((v) => !v)}
              aria-pressed={split}
              className="font-mono text-[10px] uppercase tracking-[0.14em] text-brass-dim transition-colors hover:text-brass"
            >
              {split ? "hide" : "show"} payment state
            </button>
          )}
        </div>
      </div>

      <div className="ruled mt-3 min-h-0 flex-1 overflow-y-auto">
        {orders.length === 0 ? (
          <p className="pt-6 text-[13px] text-paper-faint">
            No orders yet. Every one that appears here passed the gate first.
          </p>
        ) : (
          <ul>
            {orders.map((o) => (
              <li
                key={o.order_id}
                className="flex items-baseline gap-3 border-b border-rule py-2.5 last:border-0"
              >
                <span className="figures shrink-0 text-[11px] text-paper-faint">
                  {o.created_at === null ? "--:--:--" : clockTime(o.created_at)}
                </span>

                <span className="hash min-w-0 flex-1 truncate" title={o.order_id}>
                  {o.order_id}
                </span>

                {split ? (
                  <Pill className="border-rule text-paper-faint" title="Our order state">
                    {o.status}
                  </Pill>
                ) : null}

                <Pill
                  className={PAYMENT_TONE[o.payment_status] ?? "border-rule text-paper-faint"}
                  title={split ? "Stripe payment state" : undefined}
                >
                  {split ? o.payment_status : (PLAIN[o.payment_status] ?? o.payment_status)}
                </Pill>

                <span className="figures w-[104px] shrink-0 text-right text-[13.5px] text-paper">
                  {dollars(o.amount_cents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {split ? (
        <p className="mt-3 text-[12px] leading-relaxed text-paper-faint">
          Two states, because they answer to different parties. Ours advances
          when we act; Stripe&apos;s advances on a webhook that may arrive late,
          out of order or twice. <span className="hash">created / captured</span>{" "}
          is not a contradiction — it is the machine mid-flight.
        </p>
      ) : null}
    </section>
  );
}
