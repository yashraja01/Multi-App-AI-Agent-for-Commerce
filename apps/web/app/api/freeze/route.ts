import { mercury } from "@/lib/mercury";
import { newId } from "@mercury/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The kill switch.
 *
 * `CIRCUIT.FROZEN` is the first rule the gate checks, so a freeze takes effect on
 * the very next evaluation -- no draining, no in-flight grace period.
 */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { frozen?: boolean };
  const frozen = body.frozen === true;
  mercury().engine.setFrozen(frozen, newId("session"));
  return Response.json({ frozen: mercury().store.isFrozen() });
}
