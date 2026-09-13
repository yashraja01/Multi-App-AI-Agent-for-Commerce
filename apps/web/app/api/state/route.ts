import { BUSINESS } from "@/lib/intake";
import { calendarMode, chatMode, mailMode, mercury, railMode, sheetsMode } from "@/lib/mercury";
import { heldRuns, outboxView } from "@/lib/outbox";
import { envelopeView } from "@/lib/run";
import { SCENARIOS } from "@/lib/scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything the header and the side panels need to render a cold page. */
export async function GET(): Promise<Response> {
  const m = mercury();
  const mandateIds = [...new Set(SCENARIOS.map((s) => s.mandate_id))];

  const outbox = outboxView();
  return Response.json({
    rail_mode: railMode(),
    apps: {
      mail: mailMode(),
      chat: chatMode(),
      calendar: calendarMode(),
      sheets: sheetsMode(),
      address: m.fixtureMail?.address ?? process.env["GMAIL_USER"] ?? "",
    },
    business: BUSINESS,
    outbox: {
      pending: outbox.filter((r) => r.status === "pending").length,
      done: outbox.filter((r) => r.status === "done").length,
      failed: outbox.filter((r) => r.status === "failed").length,
      held_runs: heldRuns().length,
    },
    frozen: m.store.isFrozen(),
    merchants: m.store.listMerchants(),
    envelopes: mandateIds.map((id) => envelopeView(id)).filter((e) => e !== undefined),
    ledger_count: m.ledger.count(),
    tip: m.ledger.tipHash(),
    scenarios: SCENARIOS.map((s) => ({
      id: s.id,
      label: s.label,
      premise: s.premise,
      merchant_id: s.merchant_id,
      buyer: s.buyer,
      failure: s.failure ?? null,
    })),
  });
}
