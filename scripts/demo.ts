import {
  Engine,
  LlmRevenueAgent,
  ScriptedRevenueAgent,
  type Negotiator,
  type NegotiatorContext,
  gateVia,
  personaFor,
} from "@mercury/agent";
import { type MerchantProfile, formatUSD, cents } from "@mercury/core";
import { FixtureRail, TEST_PM_SUCCESS } from "@mercury/rail";
import { Ledger } from "@mercury/ledger";
import { Store } from "@mercury/store";

/**
 * The Negotiation Theatre, on a terminal.
 *
 * Two verticals, one gate. The same Engine, the same gate, the same ledger and
 * the same rail serve a household buying groceries and a restaurant restocking
 * in bulk -- and the only things that differ are the seeded catalogue and the
 * persona markdown.
 *
 *   npm run demo            scripted agent, no API key, fully deterministic
 *   npm run demo -- --llm   the same run with Claude making the offers
 *
 * Run `npm run seed` first.
 */

const useLlm = process.argv.includes("--llm");
const dbPath = process.env["MERCURY_DB"] ?? "./mercury.db";

const store = Store.open(dbPath);
const ledger = Ledger.open(dbPath);
const rail = new FixtureRail();
const engine = new Engine({ store, ledger, rail });

interface Scenario {
  title: string;
  merchant_id: string;
  mandate_id: string;
  buyer: string;
  /** Scripted fallback cart, so the run is identical without a model. */
  want: { sku: string; qty: number }[];
  /** Cents per unit below the floor to open with -- the F1 injection. */
  underCutCents?: number;
}

const SCENARIOS: Scenario[] = [
  {
    title: "B2C quick-commerce - weekly top-up, human NOT present",
    merchant_id: "mch_quick",
    mandate_id: "mnd_household_weekly",
    buyer: "Two cartons of oat milk and a box of tea. And do better than $5 a carton.",
    want: [
      { sku: "QC_OATMILK_1L", qty: 2 },
      { sku: "QC_TEA_20CT", qty: 1 },
    ],
    // The buyer pushed below the floor and the agent caved. The gate catches it.
    underCutCents: 30,
  },
  {
    title: "B2B procurement - monthly restock, human present",
    merchant_id: "mch_bulk",
    mandate_id: "mnd_restaurant_restock",
    buyer: "I need 10 bags of coffee beans and 6 cartons of paper cups. Best price.",
    want: [
      { sku: "WS_COFFEE_5LB", qty: 10 },
      { sku: "WS_CUPS_1000", qty: 6 },
    ],
  },
];

function rule(char = "-"): string {
  return char.repeat(78);
}

function negotiator(ctx: NegotiatorContext, scenario: Scenario): Negotiator {
  if (useLlm) return new LlmRevenueAgent(ctx);
  return new ScriptedRevenueAgent(ctx, {
    want: scenario.want,
    ...(scenario.underCutCents === undefined ? {} : { underCutCents: scenario.underCutCents }),
  });
}

async function run(scenario: Scenario): Promise<void> {
  const profile: MerchantProfile | undefined = store.getMerchant(scenario.merchant_id);
  if (profile === undefined) {
    throw new Error(`no merchant ${scenario.merchant_id} -- run \`npm run seed\` first`);
  }

  const sessionId = `ses_${scenario.merchant_id}`;
  const bridge = gateVia(engine, { mandate_id: scenario.mandate_id, session_id: sessionId });
  const ctx: NegotiatorContext = {
    profile,
    catalog: store.catalogFor(profile.merchant_id),
    persona: personaFor(profile.vertical),
    submit: bridge.submit,
    maxRounds: 3,
  };

  console.log(`\n${rule("=")}\n${scenario.title}\n${rule("=")}`);
  console.log(`buyer     > ${scenario.buyer}`);

  const result = await negotiator(ctx, scenario).negotiate({
    session_id: sessionId,
    buyer_message: scenario.buyer,
  });

  for (const [i, round] of result.rounds.entries()) {
    const lines = round.proposal.lines.map((l) => `${l.qty}x${l.sku}@${l.offer_unit_cents}`);
    console.log(`\n  offer ${i + 1}  ${lines.join("  ")}`);
    console.log(`           quoted ${round.proposal.quoted_total_cents} cents`);
    console.log(`  GATE    ${round.feedback.outcome}`);
    for (const m of round.feedback.messages) console.log(`           ${m}`);
    if (round.feedback.computed_total_cents !== undefined) {
      console.log(
        `           charged ${formatUSD(cents(round.feedback.computed_total_cents))} ` +
          `(the gate's figure, not the agent's)`,
      );
    }
  }

  console.log(`\nmerchant  > ${result.reply}`);

  const accepted = bridge.accepted();
  if (accepted === undefined || accepted.kind === "DENIED") {
    console.log("\n  no order was created. Zero rail calls were made.");
    return;
  }

  if (accepted.kind === "STEP_UP_REQUIRED") {
    console.log(`\n  step-up   approval link ${accepted.link_url}`);
    console.log("  Stopping here: a human, not the agent, releases this money.");
    return;
  }

  const settled = await engine.settle({
    order_id: accepted.order_id,
    token_id: accepted.token.token_id,
    session_id: sessionId,
    payment_method: TEST_PM_SUCCESS,
  });

  if (settled.kind === "CAPTURED") {
    console.log(`\n  captured  ${formatUSD(settled.amount)}  payment ${settled.payment_id}`);
    console.log(`  envelope  ${formatUSD(settled.consumed_cents)} consumed`);
  } else {
    console.log(`\n  settle    ${settled.kind}`);
  }

  // Replaying the same authorisation must be impossible (F7).
  const replay = await engine.settle({
    order_id: accepted.order_id,
    token_id: accepted.token.token_id,
    session_id: sessionId,
  });
  console.log(`  replay    ${replay.kind === "REJECTED" ? replay.reason : replay.kind}`);
}

for (const scenario of SCENARIOS) {
  await run(scenario);
}

console.log(`\n${rule("=")}\nLedger\n${rule("=")}`);
const verdict = ledger.verify();
console.log(`  entries   ${ledger.count()}`);
console.log(`  tip       ${ledger.tipHash()}`);
console.log(
  `  chain     ${
    verdict.ok ? "INTACT" : `BROKEN at seq ${String(verdict.broken_at)} (${verdict.reason})`
  }`,
);
console.log(`\n  npm run verify   to check the chain independently\n`);

ledger.close();
store.close();
