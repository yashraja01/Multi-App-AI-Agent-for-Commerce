import { heldRuns, outboxView, release } from "@/lib/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The outbox, from the outside.
 *
 * GET lists what is owed, done and failed (optionally for one run). POST
 * `{"action":"release"}` is the restart in the crash drill: every held action
 * is attempted, and the response says what each one did -- which is how a
 * test proves the receipt went exactly once.
 */
export async function GET(req: Request): Promise<Response> {
  const runId = new URL(req.url).searchParams.get("run_id") ?? undefined;
  const rows = outboxView(runId);
  return Response.json({
    held_runs: heldRuns(),
    counts: {
      pending: rows.filter((r) => r.status === "pending").length,
      done: rows.filter((r) => r.status === "done").length,
      failed: rows.filter((r) => r.status === "failed").length,
    },
    rows,
  });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "release") {
    return Response.json({ error: 'action must be "release"' }, { status: 400 });
  }
  const rows = await release();
  return Response.json({ released: rows.length, rows });
}
