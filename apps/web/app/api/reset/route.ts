import { mercury, reset } from "@/lib/mercury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fresh database, fresh mandates, empty ledger. */
export async function POST(): Promise<Response> {
  reset();
  return Response.json({ ok: true, ledger_count: mercury().ledger.count() });
}
