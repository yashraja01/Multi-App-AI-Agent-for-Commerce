import { runScenario, type TheatreEvent } from "@/lib/run";
import { scenarioById } from "@/lib/scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Negotiation Theatre, as a stream.
 *
 * Server-sent events rather than one JSON response: the point of the panel is
 * to watch the gate decide, and a verdict that arrives with its own outcome
 * already known is a report, not a demonstration.
 */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { scenario?: string; mode?: string; fast?: boolean };
  const scenario = scenarioById(body.scenario ?? "");
  if (scenario === undefined) {
    return Response.json({ error: `unknown scenario: ${String(body.scenario)}` }, { status: 400 });
  }
  const mode = body.mode === "llm" ? "llm" : "scripted";

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: TheatreEvent): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        await runScenario(scenario, mode, async (event) => {
          send(event);
          // A beat between events. The work is instantaneous; a human reading
          // it is not.
          if (body.fast !== true) await new Promise((r) => setTimeout(r, event.type === "verdict" ? 420 : 260));
        });
      } catch (e) {
        send({ type: "note", text: `Run failed: ${(e as Error).message}` });
      } finally {
        controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
