import { mercury } from "@/lib/mercury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The the ledger explorer's data source. Newest last, so the chain reads downward. */
export async function GET(req: Request): Promise<Response> {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "60");
  const m = mercury();
  const all = m.ledger.read();
  const entries = all.slice(Math.max(0, all.length - (Number.isFinite(limit) ? limit : 60)));

  return Response.json({
    count: m.ledger.count(),
    tip: m.ledger.tipHash(),
    entries,
  });
}
