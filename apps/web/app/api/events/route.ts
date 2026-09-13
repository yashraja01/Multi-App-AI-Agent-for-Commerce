import { type BusEvent, bus } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The run bus, as a stream.
 *
 * A Mission Control tab subscribes here to watch runs it did not start -- the
 * ones an email set off. `?since=<seq>` replays what a late subscriber missed
 * from the in-memory ring, then the stream stays open for whatever comes next.
 */
export async function GET(req: Request): Promise<Response> {
  const since = Number(new URL(req.url).searchParams.get("since") ?? "0");
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: BusEvent): void => {
        controller.enqueue(encoder.encode(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
      };
      for (const e of bus().since(Number.isFinite(since) ? since : 0)) send(e);
      unsubscribe = bus().subscribe(send);
      keepalive = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 15_000);
    },
    cancel() {
      unsubscribe?.();
      if (keepalive !== undefined) clearInterval(keepalive);
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
