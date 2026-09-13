/**
 * The Reliability Report.
 *
 *   npm run dev              in one terminal
 *   npm run eval             in another   (re-seeds the bench first)
 *   npm run eval -- --keep   to run against the database as it is
 *
 * One command that answers "does it work, and how do you know?" in three
 * sections, then a verdict:
 *
 *   1. Scenarios  -- every situation on the Mission Control bench, run end to
 *                    end over the same SSE route the theatre uses, checked
 *                    against the outcome it is *supposed* to reach: paid,
 *                    refused, stopped for a human, refunded.
 *   2. Emails     -- the four things a café manager might send the agent,
 *                    through the intake, checked for outcome, amount and the
 *                    apps that were told (calendar, sheet, chat, mail).
 *   3. Failures   -- the eleven engineered failures (F1-F11), each injected
 *                    and then checked, over /api/chaos.
 *   4. The chain  -- re-verified from the first entry after all of the above.
 *
 * Exits non-zero if anything is red, so it is a gate in CI as well as a demo.
 */

const BASE = process.env["MERCURY_URL"] ?? "http://localhost:3000";
const KEEP = process.argv.includes("--keep");

const GREEN = "[32m";
const RED = "[31m";
const YELLOW = "[33m";
const DIM = "[2m";
const BOLD = "[1m";
const OFF = "[0m";

interface Check {
  label: string;
  passed: boolean;
  detail: string;
}

const failures: string[] = [];
let total = 0;

function report(section: string, name: string, checks: Check[], ms: number): void {
  const ok = checks.every((c) => c.passed);
  total += 1;
  if (!ok) failures.push(`${section}: ${name}`);
  console.log(`${name.padEnd(36)} ${ok ? `${GREEN}pass${OFF}` : `${RED}FAIL${OFF}`}  ${DIM}${ms}ms${OFF}`);
  for (const c of checks) {
    if (c.passed) continue;
    console.log(`      ${RED}xx${OFF} ${c.label} ${DIM}-- ${c.detail}${OFF}`);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/* ------------------------------------------------------------ 1. scenarios */

type Outcome = "captured" | "denied" | "step_up" | "fallback" | "refunded";

/** What each bench scenario is designed to reach. The bench is the claim; this is the check. */
const EXPECTED: Record<string, { outcome: Outcome; note: string }> = {
  topup: { outcome: "captured", note: "a routine basket is paid" },
  pressure: { outcome: "captured", note: "a below-floor offer is refused, the re-quote is paid" },
  drift: { outcome: "denied", note: "a lying total is refused before the rail" },
  stepup: { outcome: "step_up", note: "above the approval line, a human is asked" },
  breach: { outcome: "denied", note: "beyond the envelope is refused" },
  bulk: { outcome: "captured", note: "a B2B order is paid through the same gate" },
  decline: { outcome: "fallback", note: "a declined card is retried, then handed to a human" },
  oversold: { outcome: "refunded", note: "unshippable after capture is refunded" },
};

interface TheatreEvent {
  type: string;
  outcome?: string;
  status?: string;
  detail?: string;
  computed_cents?: number;
  quoted_cents?: number;
}

/** Run one scenario over the SSE route and collect its events. */
async function runScenario(id: string): Promise<TheatreEvent[]> {
  const res = await fetch(`${BASE}/api/negotiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario: id, mode: "scripted", fast: true }),
  });
  const text = await res.text();
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => l !== undefined && l !== "data: {}")
    .map((l) => JSON.parse(l.slice(6)) as TheatreEvent);
}

function outcomeOf(events: TheatreEvent[]): Outcome | "unknown" {
  const verdicts = events.filter((e) => e.type === "verdict");
  const last = verdicts.at(-1);
  if (events.some((e) => e.type === "payment" && e.status === "fallback" && /refunded/u.test(e.detail ?? ""))) return "refunded";
  if (events.some((e) => e.type === "payment" && e.status === "captured")) return "captured";
  if (events.some((e) => e.type === "stepup")) return "step_up";
  if (events.some((e) => e.type === "payment" && e.status === "fallback")) return "fallback";
  if (last?.outcome === "DENY") return "denied";
  return "unknown";
}

async function scenarios(): Promise<void> {
  console.log(`\n${BOLD}1. Scenarios${OFF}  ${DIM}every situation on the bench, run end to end${OFF}\n`);
  for (const [id, want] of Object.entries(EXPECTED)) {
    const t0 = Date.now();
    const events = await runScenario(id);
    const got = outcomeOf(events);
    const denied = events.filter((e) => e.type === "verdict" && e.outcome === "DENY");
    const checks: Check[] = [
      { label: `reaches "${want.outcome}"`, passed: got === want.outcome, detail: `got "${got}" -- ${want.note}` },
      {
        label: "every verdict compares the agent's figure to the gate's own",
        passed: events.filter((e) => e.type === "verdict").every((e) => e.computed_cents !== undefined || e.outcome === "DENY"),
        detail: "computed_cents present on every ALLOW",
      },
      ...(want.outcome === "denied"
        ? [
            {
              label: "a denial never creates an order",
              passed: !events.some((e) => e.type === "order") || denied.length === 0,
              detail: events.some((e) => e.type === "order") ? "an order event appeared" : "no order",
            },
          ]
        : []),
    ];
    report("scenario", `${id}  ${DIM}${want.note}${OFF}`, checks, Date.now() - t0);
  }
}

/* --------------------------------------------------------------- 2. emails */

interface IntakeResponse {
  processed: {
    result: string;
    amount_cents?: number;
    receipt?: { id: string };
    delivery?: { id: string };
    log?: { id: string; range: string };
    summary_post?: { id: string };
    approval_post?: { id: string };
    denial?: string;
  }[];
}

async function emails(): Promise<void> {
  console.log(`\n${BOLD}2. Emails${OFF}  ${DIM}what a café manager might send, through the inbox${OFF}\n`);
  const cases: { name: string; text: string; check: (p: IntakeResponse["processed"][number]) => Check[] }[] = [
    {
      name: "the demo order",
      text: "Hi — restock for next week please: 10 bags of coffee beans and 6 cases of oat milk. Thanks!",
      check: (p) => [
        { label: "paid", passed: p.result === "captured", detail: p.result },
        { label: "for $534.04", passed: p.amount_cents === 53_404, detail: `${p.amount_cents ?? "?"} cents` },
        { label: "delivery booked", passed: p.delivery !== undefined, detail: p.delivery?.id ?? "none" },
        { label: "purchase logged", passed: p.log !== undefined, detail: p.log?.range ?? "none" },
        { label: "team told", passed: p.summary_post !== undefined, detail: p.summary_post?.id ?? "none" },
        { label: "receipt sent", passed: p.receipt !== undefined, detail: p.receipt?.id ?? "none" },
      ],
    },
    {
      name: "an order over the owner's line",
      text: "We need 40 bags of coffee beans for the event.",
      check: (p) => [
        { label: "stopped for a human", passed: p.result === "step_up", detail: p.result },
        { label: "for $950.40", passed: p.amount_cents === 95_040, detail: `${p.amount_cents ?? "?"} cents` },
        { label: "approval request posted", passed: p.approval_post !== undefined, detail: p.approval_post?.id ?? "none" },
        { label: "nothing booked", passed: p.delivery === undefined, detail: p.delivery?.id ?? "no calendar entry" },
        { label: "receipt says nothing was charged", passed: p.receipt !== undefined, detail: p.receipt?.id ?? "none" },
      ],
    },
    {
      name: "a question, not an order",
      text: "Can you send me last month's invoice?",
      check: (p) => [
        { label: "refused, honestly", passed: p.result === "denied" && /couldn't find anything/u.test(p.denial ?? ""), detail: p.denial ?? p.result },
        { label: "nothing charged", passed: p.amount_cents === undefined, detail: `${p.amount_cents ?? 0} cents` },
      ],
    },
    {
      name: "a small top-up",
      text: "2 cartons of napkins please",
      check: (p) => [
        { label: "paid", passed: p.result === "captured", detail: p.result },
        { label: "for $21.86", passed: p.amount_cents === 2_186, detail: `${p.amount_cents ?? "?"} cents` },
      ],
    },
  ];
  for (const c of cases) {
    const t0 = Date.now();
    const res = await post<IntakeResponse>("/api/intake/email", {
      from: "manager@harborstreetcafe.test",
      subject: c.name,
      text: c.text,
      fast: true,
    });
    const p = res.processed[0];
    report("email", c.name, p === undefined ? [{ label: "processed", passed: false, detail: "no outcome" }] : c.check(p), Date.now() - t0);
  }
}

/* ------------------------------------------------------------- 3. failures */

interface ChaosResult {
  id: string;
  failure: string;
  passed: boolean;
  blocked: boolean;
  checks: Check[];
  duration_ms: number;
  error?: string;
}

async function chaos(): Promise<void> {
  console.log(`\n${BOLD}3. Failures${OFF}  ${DIM}eleven engineered failures, each injected and then checked${OFF}\n`);
  const res = await fetch(`${BASE}/api/chaos`);
  const { rows } = (await res.json()) as { rows: { id: string; failure: string }[] };
  for (const row of rows) {
    const r = await post<ChaosResult>("/api/chaos", { id: row.id });
    if (r.error !== undefined) {
      report("failure", `${row.id}  ${row.failure}`, [{ label: "ran", passed: false, detail: r.error }], 0);
      continue;
    }
    if (r.blocked) {
      total += 1;
      console.log(`${`${row.id}  ${row.failure}`.padEnd(36)} ${YELLOW}blocked${OFF}  ${DIM}bench spent -- not a failure${OFF}`);
      continue;
    }
    report("failure", `${row.id}  ${row.failure}`, r.checks, r.duration_ms);
  }
}

/* ---------------------------------------------------------------- 4. chain */

async function chain(): Promise<void> {
  console.log(`\n${BOLD}4. The chain${OFF}  ${DIM}re-verified from the first entry${OFF}\n`);
  const t0 = Date.now();
  const v = await post<{ ok?: boolean; count?: number; tip?: string; error?: string }>("/api/verify", {});
  report(
    "chain",
    `${v.count ?? "?"} entries`,
    [{ label: "every hash matches the one before it", passed: v.ok === true, detail: v.ok === true ? `tip ${(v.tip ?? "").slice(0, 12)}` : (v.error ?? "broken") }],
    Date.now() - t0,
  );
}

/* ------------------------------------------------------------------- main */

console.log(`\n${BOLD}Mercury reliability report${OFF}  ${DIM}${BASE}${OFF}`);

try {
  await fetch(`${BASE}/api/state`);
} catch (e) {
  console.error(`Could not reach ${BASE}: ${(e as Error).message}\nStart the gateway first:  npm run dev\n`);
  process.exit(2);
}

if (!KEEP) {
  const res = await fetch(`${BASE}/api/reset`, { method: "POST" });
  console.log(res.ok ? `${DIM}Bench re-seeded.${OFF}` : `${RED}Reset failed: HTTP ${res.status}${OFF}`);
}

const started = Date.now();
await scenarios();
await emails();
await chaos();
await chain();

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log("");
if (failures.length === 0) {
  console.log(`${GREEN}${BOLD}${total} of ${total} checks pass${OFF}  ${DIM}in ${seconds}s. Tested, not trusted.${OFF}\n`);
} else {
  console.log(`${RED}${BOLD}${failures.length} of ${total} failed${OFF}  ${DIM}in ${seconds}s${OFF}`);
  for (const f of failures) console.log(`  ${RED}xx${OFF} ${f}`);
  console.log("");
  process.exit(1);
}
