import { mercury } from "@/lib/mercury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-walk the whole chain and report.
 *
 * The same check `npm run verify` runs from the command line, and the same one
 * an outside auditor would run against the file. Nothing here trusts a cached
 * answer.
 */
export async function POST(): Promise<Response> {
  const started = performance.now();
  const result = mercury().ledger.verify();
  return Response.json({
    ...result,
    tip: mercury().ledger.tipHash(),
    took_ms: Number((performance.now() - started).toFixed(2)),
  });
}
