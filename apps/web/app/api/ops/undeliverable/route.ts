import { TransactError, reportUndeliverable } from "@/lib/transact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The merchant reports that a captured order cannot ship.
 *
 * Deliberately under /api/ops and not /api/agent: this is the merchant's own
 * admission, not something a buyer can assert. A buyer claiming its goods never
 * arrived is a dispute, which is a different problem with a different answer.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { order_id?: string; reason?: string };
    if (typeof body.order_id !== "string") {
      return Response.json({ error: "order_id is required" }, { status: 400 });
    }
    const result = await reportUndeliverable({
      order_id: body.order_id,
      reason: body.reason ?? "stock unavailable after capture",
    });
    return Response.json(result);
  } catch (e) {
    if (e instanceof TransactError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
