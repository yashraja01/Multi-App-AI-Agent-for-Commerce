/**
 * The failure-audit table, run.
 *
 *   npm run dev             in one terminal
 *   npm run chaos           in another
 *   npm run chaos -- --reset  to re-seed the bench first
 *
 * Every row is driven through the same HTTP surface Mission Control uses, so
 * this prints exactly what the Chaos Console shows -- one implementation, two
 * front ends. Exits non-zero if any row fails, which makes it usable as a gate
 * in CI rather than only as a demo.
 */

const BASE = process.env["MERCURY_URL"] ?? "http://localhost:3000";
const RESET = process.argv.includes("--reset");

interface ChaosCheck {
  label: string;
  passed: boolean;
  detail: string;
}

interface ChaosRow {
  id: string;
  failure: string;
  injection: string;
  expected: string;
  ledger: string[];
}

interface BenchStatus {
  txn_count: number;
  max_txn_count: number;
  remaining_cents: number;
  stock: { sku: string; available: number }[];
  runs_left: number;
  ready: boolean;
  reason: string | null;
}

interface ChaosResult extends ChaosRow {
  passed: boolean;
  blocked: boolean;
  checks: ChaosCheck[];
  observed: string[];
  ledger_from: number;
  ledger_to: number;
  duration_ms: number;
  bench: BenchStatus;
  error?: string;
}

const GREEN = "[32m";
const RED = "[31m";
const YELLOW = "[33m";
const DIM = "[2m";
const OFF = "[0m";

async function bench(): Promise<{ rows: ChaosRow[]; bench: BenchStatus }> {
  const res = await fetch(`${BASE}/api/chaos`);
  if (!res.ok) throw new Error(`GET /api/chaos -> ${res.status}`);
  return (await res.json()) as { rows: ChaosRow[]; bench: BenchStatus };
}

function benchLine(b: BenchStatus): string {
  const stock = b.stock.map((s) => `${s.sku} x${s.available}`).join(", ");
  const budget = `$${(b.remaining_cents / 100).toFixed(2)}`;
  return b.ready
    ? `${DIM}bench: ${b.txn_count}/${b.max_txn_count} debits used, ${budget} left, ${stock} -- ${b.runs_left} full pass(es) left${OFF}`
    : `${DIM}bench: ${OFF}${b.reason ?? "spent"}${DIM} -- re-seed with: npm run chaos -- --reset${OFF}`;
}

async function run(id: string): Promise<ChaosResult> {
  const res = await fetch(`${BASE}/api/chaos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return (await res.json()) as ChaosResult;
}

console.log(`\nMercury chaos console -- ${BASE}`);
console.log("Seven engineered failures, each injected and then checked.\n");

if (RESET) {
  // Destroys the database and re-seeds it, ledger included. Explicit on the
  // command line, never implicit: the chain is the artifact.
  const res = await fetch(`${BASE}/api/reset`, { method: "POST" });
  console.log(res.ok ? "Bench re-seeded.\n" : `Reset failed: HTTP ${res.status}\n`);
}

let table: ChaosRow[];
let start: BenchStatus;
try {
  const state = await bench();
  table = state.rows;
  start = state.bench;
} catch (e) {
  console.error(`Could not reach ${BASE}: ${(e as Error).message}`);
  console.error("Start the gateway first:  npm run dev\n");
  process.exit(2);
}

console.log(`${benchLine(start)}\n`);

const results: ChaosResult[] = [];

for (const row of table) {
  process.stdout.write(`${row.id}  ${row.failure.padEnd(30)} `);
  const result = await run(row.id);
  results.push(result);

  if (result.error !== undefined) {
    console.log(`${RED}error${OFF}  ${result.error}`);
    continue;
  }

  console.log(
    result.blocked
      ? `${YELLOW}blocked${OFF}  ${DIM}bench spent -- not a failure${OFF}`
      : result.passed
        ? `${GREEN}verified${OFF} ${DIM}${result.duration_ms}ms${OFF}`
        : `${RED}FAILED${OFF}   ${DIM}${result.duration_ms}ms${OFF}`,
  );

  for (const check of result.checks) {
    const mark = check.passed ? `${GREEN}ok${OFF}` : result.blocked ? `${YELLOW}--${OFF}` : `${RED}xx${OFF}`;
    console.log(`      ${mark} ${check.label} ${DIM}-- ${check.detail}${OFF}`);
  }
  if (result.blocked) continue;
  console.log(`      ${DIM}ledger ${result.ledger_from}-${result.ledger_to}: ${result.observed.join(", ")}${OFF}`);
}

/* The chain has to still verify after all of that. */
const verified = await fetch(`${BASE}/api/verify`, { method: "POST" });
const chain = (await verified.json()) as { ok?: boolean; count?: number };
const chainOk = chain.ok === true;

const passed = results.filter((r) => r.passed).length;
const blocked = results.filter((r) => r.blocked).length;
const failed = results.filter((r) => !r.passed && !r.blocked).length;
const last = results[results.length - 1]?.bench;

console.log(
  `\n${failed === 0 && blocked === 0 ? GREEN : blocked > 0 && failed === 0 ? YELLOW : RED}` +
    `${passed}/${table.length} rows verified${OFF}` +
    (blocked > 0 ? `   ${YELLOW}${blocked} blocked${OFF}` : "") +
    (failed > 0 ? `   ${RED}${failed} failed${OFF}` : "") +
    `   chain: ${chainOk ? `${GREEN}intact${OFF}` : `${RED}BROKEN${OFF}`}` +
    ` (${String(chain.count ?? 0)} entries)`,
);
if (last !== undefined) console.log(benchLine(last));
console.log("");

/*
 * Three outcomes, three exit codes. A spent bench is not a failing gate, and a
 * CI job that cannot tell them apart will eventually be ignored.
 *   0  everything verified
 *   1  a row genuinely failed, or the chain broke
 *   3  the bench ran out before the table did
 */
if (failed > 0 || !chainOk) process.exit(1);
process.exit(blocked > 0 ? 3 : 0);
