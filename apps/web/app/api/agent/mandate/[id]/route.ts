import { mercury } from "@/lib/mercury";
import { envelopeView } from "@/lib/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What authority is left.
 *
 * A well-behaved buyer agent checks this before it starts negotiating, so it
 * asks for a basket it can actually pay for. The limits are published because
 * they travel inside the signed mandate anyway -- there is nothing here the
 * buyer's own human did not authorise.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const m = mercury();
  const signed = m.store.getMandate(id);
  const envelope = envelopeView(id);

  if (signed === undefined || envelope === undefined) {
    return Response.json({ error: `no such mandate: ${id}` }, { status: 404 });
  }

  const mandate = signed.mandate;
  return Response.json({
    ...envelope,
    vertical: mandate.vertical,
    human_present: mandate.human_present,
    max_per_txn_cents: mandate.max_per_txn_cents,
    requires_human_approval_above_cents: mandate.requires_human_approval_above_cents,
    scope: mandate.scope,
    not_before: mandate.not_before,
    expires_at: mandate.expires_at,
    frozen: m.store.isFrozen(),
    currency: "USD",
    minor_unit: "cents",
  });
}
