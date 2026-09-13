import { mercury } from "@/lib/mercury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The audit trail, for the buyer's side.
 *
 * A buyer agent can read back exactly what was decided about it and re-verify
 * the chain itself. Nothing here is filtered by us being the merchant: the same
 * entries an auditor would see.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const session = url.searchParams.get("session_id");
  const limit = Number(url.searchParams.get("limit") ?? "40");

  const m = mercury();
  const all = m.ledger.read();
  const filtered =
    session === null ? all : all.filter((e) => e.session_id === session);
  const entries = filtered.slice(
    Math.max(0, filtered.length - (Number.isFinite(limit) ? limit : 40)),
  );

  const verdict = m.ledger.verify();
  return Response.json({
    chain: verdict.ok
      ? { ok: true, count: verdict.count, tip: m.ledger.tipHash() }
      : { ok: false, count: verdict.count, broken_at: verdict.broken_at, reason: verdict.reason },
    entries,
  });
}
