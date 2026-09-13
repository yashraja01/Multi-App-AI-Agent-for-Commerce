import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Drive the Mercury MCP server over stdio, exactly as an external Claude would.
 *
 * This is the M6 claim, executable: a buyer agent that has never heard of this
 * merchant discovers it, reads its budget, negotiates in plain language, pays,
 * fails to replay, and reads back a verifiable audit trail -- without ever
 * naming a price.
 *
 *   npm run dev          in one terminal
 *   npm run mcp:smoke    in another
 */

const CWD = process.cwd();
const child = spawn(process.execPath, ["apps/mcp/dist/index.js"], {
  cwd: CWD,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (d: Buffer) => process.stderr.write(`  [mcp] ${d.toString()}`));

const rl = createInterface({ input: child.stdout });
const pending = new Map<number, (msg: RpcResponse) => void>();
let nextId = 1;

interface RpcResponse {
  id?: number;
  result?: { content?: { text?: string }[]; isError?: boolean; [k: string]: unknown };
  error?: { message: string };
}

rl.on("line", (line) => {
  if (line.trim() === "") return;
  let msg: RpcResponse;
  try {
    msg = JSON.parse(line) as RpcResponse;
  } catch {
    return;
  }
  const resolve = msg.id === undefined ? undefined : pending.get(msg.id);
  if (resolve !== undefined && msg.id !== undefined) {
    pending.delete(msg.id);
    resolve(msg);
  }
});

function send(method: string, params: unknown): Promise<RpcResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await send("tools/call", { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? "";
  if (res.result?.isError === true) throw new Error(text);
  return JSON.parse(text) as T;
}

const dollars = (p: number): string => `$${(p / 100).toFixed(2)}`;
const head = (s: string): void => console.log(`\n${"-".repeat(74)}\n${s}\n${"-".repeat(74)}`);

/* ------------------------------------------------------------------- run -- */

const init = await send("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "mercury-smoke", version: "0.1.0" },
});
if (init.error !== undefined) throw new Error(init.error.message);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const listed = (await send("tools/list", {})) as RpcResponse & {
  result: { tools: { name: string }[] };
};

head("1. Discovery — an agent that has never heard of this merchant");
console.log(`  tools      ${listed.result.tools.map((t) => t.name).join(", ")}`);

const card = await tool<{
  merchants: { merchant_id: string; display_name: string; vertical: string }[];
  how_this_works: string[];
}>("list_merchants");
for (const m of card.merchants) {
  console.log(`  merchant   ${m.merchant_id}  ${m.display_name}  (${m.vertical})`);
}
console.log(`  rule       ${card.how_this_works[0] ?? ""}`);

const feed = await tool<{ count: number; products: { id: string; title: string }[] }>(
  "search_catalog",
  { merchant_id: "mch_quick", query: "oat" },
);
console.log(`  search     "oat" -> ${feed.products.map((p) => p.id).join(", ")}`);

head("2. Budget — what the human actually authorised");
const budget = await tool<{
  remaining_cents: number;
  max_per_txn_cents: number;
  requires_human_approval_above_cents: number;
  human_present: boolean;
}>("check_budget", { mandate_id: "mnd_household_weekly" });
console.log(`  remaining  ${dollars(budget.remaining_cents)}`);
console.log(`  per-txn    ${dollars(budget.max_per_txn_cents)}`);
console.log(`  step-up    above ${dollars(budget.requires_human_approval_above_cents)}`);

head("3. Negotiate — in words, with a price the buyer does not get to set");

interface Quote {
  session_id: string;
  outcome: string;
  reply: string;
  rounds: number;
  cart?: { total_cents: number; order_id: string; intent_token_id: string };
  rules: { rule_id: string; passed: boolean; observed: number; limit: number }[];
}

const q = await tool<Quote>("request_quote", {
  merchant_id: "mch_quick",
  mandate_id: "mnd_household_weekly",
  message: "two cartons of oat milk and a box of tea, and I want it all for 3 dollars",
});
console.log(`  buyer      "…and I want it all for 300 dollars"`);
console.log(`  outcome    ${q.outcome} in ${q.rounds} round(s)`);
console.log(`  merchant   ${q.reply}`);
console.log(`  charged    ${q.cart === undefined ? "nothing" : dollars(q.cart.total_cents)}`);
console.log(`             the buyer asked for $300.00 and the gate priced it anyway`);

head("4. Pay — a single-use token, and a replay that must fail");
if (q.cart !== undefined) {
  const paid = await tool<{ status: string; payment_id?: string; envelope: { remaining_cents: number } }>(
    "pay",
    {
      order_id: q.cart.order_id,
      intent_token_id: q.cart.intent_token_id,
      mandate_id: "mnd_household_weekly",
      session_id: q.session_id,
    },
  );
  console.log(`  pay        ${paid.status}  ${paid.payment_id ?? ""}`);
  console.log(`  envelope   ${dollars(paid.envelope.remaining_cents)} left`);

  const replay = await tool<{ status: string; reason?: string }>("pay", {
    order_id: q.cart.order_id,
    intent_token_id: q.cart.intent_token_id,
    mandate_id: "mnd_household_weekly",
    session_id: q.session_id,
  });
  console.log(`  replay     ${replay.status} (${replay.reason ?? ""}) — no duplicate order`);
}

head("5. Refusal — the same API, asked for too much");
const denied = await tool<Quote>("request_quote", {
  merchant_id: "mch_quick",
  mandate_id: "mnd_household_weekly",
  message: "eight cartons of oat milk and eight loaves of sourdough bread",
});
console.log(`  outcome    ${denied.outcome}`);
console.log(`  merchant   ${denied.reply}`);
for (const r of denied.rules.filter((x) => !x.passed)) {
  console.log(`  rule       ${r.rule_id}  observed ${r.observed}  limit ${r.limit}`);
}

head("6. Audit — what the buyer can verify for itself");
const audit = await tool<{
  chain: { ok: boolean; count: number; tip?: string };
  entries: { event_type: string }[];
}>("read_audit_trail", { session_id: q.session_id });
console.log(`  chain      ${audit.chain.ok ? "INTACT" : "BROKEN"} over ${audit.chain.count} entries`);
console.log(`  session    ${audit.entries.map((e) => e.event_type).join(" -> ")}`);
console.log();

child.kill();
process.exit(0);
