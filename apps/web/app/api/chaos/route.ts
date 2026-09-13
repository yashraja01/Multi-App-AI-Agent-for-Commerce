import { CHAOS_ROWS, type FailureId, benchStatus, chaosRow, runChaos } from "@/lib/chaos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The bench itself, for rendering the table before anything has been run.
 *
 * Ships the bench's remaining budget alongside the rows so the panel can say
 * how many passes are left *before* someone starts a run that cannot finish.
 */
export async function GET(): Promise<Response> {
  return Response.json({ rows: CHAOS_ROWS, bench: benchStatus() });
}

/**
 * Run one row of the failure-audit table.
 *
 * The origin is taken from the request rather than configured, so the rows
 * that must travel over HTTP -- the forged webhook, the duplicate delivery, the
 * token replay -- call back into this same running app on whatever host and
 * port it happens to be serving.
 */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { id?: string };
  const row = chaosRow(body.id ?? "");
  if (row === undefined) {
    return Response.json({ error: `unknown failure row: ${String(body.id)}` }, { status: 400 });
  }

  try {
    const result = await runChaos(row.id as FailureId, new URL(req.url).origin);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
