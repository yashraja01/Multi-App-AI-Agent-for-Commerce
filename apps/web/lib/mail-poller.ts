import "server-only";
import { pullAndProcess } from "./intake";
import { mercury } from "./mercury";

/**
 * The background pull, for live Gmail.
 *
 * In fixture mode there is nothing to poll: the test-email button injects and
 * processes in one request. Against Gmail the request arrives whenever the
 * manager presses send, so someone has to look -- every MAIL_POLL_SECONDS,
 * one pull, requests processed in order.
 *
 * Started lazily by the first request that touches the inbox, and only once
 * per process. A `setInterval` inside a Next.js server is not elegant, but a
 * demo needs exactly one of these and a queue would be a second system.
 */

declare global {
  // eslint-disable-next-line no-var
  var __mercury_mail_poller__: { origin: string; timer: ReturnType<typeof setInterval> } | undefined;
}

export function ensureMailPoller(origin: string): void {
  if (mercury().fixtureMail !== undefined) return;
  if (globalThis.__mercury_mail_poller__ !== undefined) return;

  const seconds = Math.max(5, Number(process.env["MAIL_POLL_SECONDS"] ?? "15"));
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    pullAndProcess("scripted", origin)
      .catch((e: unknown) => {
        console.error(`[mail-poller] pull failed: ${(e as Error).message}`);
      })
      .finally(() => {
        busy = false;
      });
  }, seconds * 1000);
  timer.unref?.();
  globalThis.__mercury_mail_poller__ = { origin, timer };
}
