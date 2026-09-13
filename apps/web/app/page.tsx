import { MissionControl } from "@/components/MissionControl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The whole app is one board.
 *
 * The only thing the server decides here is whether Claude is reachable, which
 * gates the agent-mode switch. Everything else the client fetches, so the page
 * is honest about the fact that it is watching a running system rather than
 * rendering a snapshot.
 */
export default function Page() {
  const key = process.env["ANTHROPIC_API_KEY"];
  return <MissionControl llmAvailable={key !== undefined && key !== ""} />;
}
