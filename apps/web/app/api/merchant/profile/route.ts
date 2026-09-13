import { ALL_MERCHANTS } from "@mercury/seed";
import { newId, zPolicyPatch } from "@mercury/core";
import { mercury } from "@/lib/mercury";
import { applyPolicyPatch, policyDrift } from "@/lib/policy";
import type { PolicyView } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A merchant's own policy: what it is, and how to change it.
 *
 * The gate re-reads the profile on every evaluation (`Engine.propose`), so a
 * change here takes effect on the very next negotiation. There is no cache to
 * invalidate and no restart -- which is the point: a margin floor you have to
 * redeploy to move is not a control, it is a constant.
 */

function seededProfile(merchantId: string) {
  return ALL_MERCHANTS.find((m) => m.merchant_id === merchantId);
}

function view(merchantId: string): PolicyView | undefined {
  const profile = mercury().store.getMerchant(merchantId);
  if (profile === undefined) return undefined;
  const seeded = seededProfile(merchantId);
  return {
    profile,
    modified: seeded === undefined ? [] : policyDrift(profile, seeded),
    seeded: seeded ?? null,
  };
}

export async function GET(req: Request): Promise<Response> {
  const merchantId = new URL(req.url).searchParams.get("merchant_id");
  if (merchantId === null) return Response.json({ error: "merchant_id required" }, { status: 400 });

  const v = view(merchantId);
  return v === undefined
    ? Response.json({ error: `no merchant ${merchantId}` }, { status: 404 })
    : Response.json(v);
}

export async function POST(req: Request): Promise<Response> {
  const parsed = zPolicyPatch.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: "invalid patch", issues: parsed.error.issues }, { status: 400 });
  }

  const m = mercury();
  const current = m.store.getMerchant(parsed.data.merchant_id);
  if (current === undefined) {
    return Response.json({ error: `no merchant ${parsed.data.merchant_id}` }, { status: 404 });
  }

  const { next, changes } = applyPolicyPatch(current, parsed.data);

  /*
   * A no-op is not an event. Writing POLICY_CHANGED every time someone presses
   * Save without moving anything would pad the chain with entries that record
   * nothing, and a ledger you learn to skim is a ledger that has stopped
   * working.
   */
  if (changes.length > 0) {
    m.store.putMerchant(next);
    m.ledger.append({
      // The merchant, not the agent. The whole point of this record is that a
      // human loosened the rule the agent has to obey.
      actor: { type: "human", id: next.merchant_id },
      event_type: "POLICY_CHANGED",
      session_id: newId("session"),
      detail: { merchant_id: next.merchant_id, changes },
    });
  }

  return Response.json({ ...view(next.merchant_id), changes });
}
