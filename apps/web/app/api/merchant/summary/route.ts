import { mercury } from "@/lib/mercury";
import type { LeverEarning, MerchantSummary, OrderView } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the Revenue Agent earned this merchant, read back out of the chain.
 *
 * Deliberately computed from the ledger rather than from a running total kept
 * somewhere convenient. The uplift a merchant sees is therefore the same number
 * an outside party would arrive at by walking the ledger -- if the two could
 * disagree, the audit trail would not be the source of truth, it would be a
 * copy of one.
 */

interface ValuedDetail {
  merchant_id?: unknown;
  baseline_cents?: unknown;
  final_cents?: unknown;
  uplift_cents?: unknown;
  levers_used?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export async function GET(req: Request): Promise<Response> {
  const merchantId = new URL(req.url).searchParams.get("merchant_id");
  if (merchantId === null) return Response.json({ error: "merchant_id required" }, { status: 400 });

  const m = mercury();

  const valued = m.ledger
    .byEventType("BASKET_VALUED")
    .map((e) => (e.detail ?? {}) as ValuedDetail)
    .filter((d) => d.merchant_id === merchantId);

  let baseline = 0;
  let final = 0;
  const byLever = new Map<string, LeverEarning>();

  for (const d of valued) {
    baseline += num(d.baseline_cents);
    final += num(d.final_cents);

    const levers = Array.isArray(d.levers_used) ? (d.levers_used as unknown[]) : [];
    for (const raw of levers) {
      if (typeof raw !== "string") continue;
      const entry = byLever.get(raw) ?? { lever: raw, baskets: 0, uplift_cents: 0 };
      entry.baskets += 1;
      /*
       * Attribution is even across the levers a basket used, not clever. Two
       * levers on one basket cannot be separated after the fact -- the gate
       * priced the cart, not each lever's contribution to it -- and inventing a
       * weighting would dress a guess up as a measurement.
       */
      entry.uplift_cents += Math.round(num(d.uplift_cents) / levers.length);
      byLever.set(raw, entry);
    }
  }

  const uplift = final - baseline;

  const orders: OrderView[] = m.store
    .listOrders({ merchantId, limit: 25 })
    .map((o) => ({
      order_id: o.order_id,
      mandate_id: o.mandate_id,
      amount_cents: o.amount,
      status: o.status,
      payment_status: o.payment_status,
      created_at: o.created_at,
    }));

  const summary: MerchantSummary = {
    merchant_id: merchantId,
    baskets: valued.length,
    baseline_cents: baseline,
    final_cents: final,
    uplift_cents: uplift,
    uplift_bps: baseline === 0 ? 0 : Math.round((uplift / baseline) * 10_000),
    levers: [...byLever.values()].sort((a, b) => b.uplift_cents - a.uplift_cents),
    orders,
  };

  return Response.json(summary);
}
