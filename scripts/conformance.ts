/**
 * The published surface, checked against the shape it claims.
 *
 *   npm run dev            in one terminal
 *   npm run conformance    in another
 *
 * Mercury publishes an A2A Agent Card and a UCP/ACP-shaped product feed, and
 * until this existed nothing checked either of them. A shape claimed in a README
 * and a shape actually served are different things, and the gap between them is
 * exactly what a buyer agent falls into.
 *
 * Two kinds of assertion live here, and the second matters more:
 *
 *   SHAPE     the fields a buyer agent needs are present, correctly typed, and
 *             money is an integer minor unit with the unit named.
 *   LEAKAGE   the fields a public document must NEVER carry are absent --
 *             landed cost, the margin floor, and supplier account ids. Those
 *             are the merchant's own economics and its suppliers' banking
 *             details. A feed is world-readable; a leak here is not a bug you
 *             fix quietly in the next release.
 *
 * We implement these shapes faithfully and claim no certification (see
 * CONTEXT.md, non-goals). This checks our own claim, not somebody's spec badge.
 */

const BASE = process.env["MERCURY_URL"] ?? "http://localhost:3000";

const GREEN = "[32m";
const RED = "[31m";
const DIM = "[2m";
const OFF = "[0m";

interface Check {
  doc: string;
  label: string;
  passed: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(doc: string, label: string, passed: boolean, detail: string): void {
  checks.push({ doc, label, passed, detail });
}

/**
 * Fields that must never appear anywhere in a public document.
 *
 * Matched against the raw JSON text rather than against parsed fields, because
 * the risk is a key added later inside a nested object nobody thought about.
 * A substring scan cannot be out-manoeuvred by nesting.
 */
const NEVER_PUBLIC = [
  "cost_cents",
  "landed_cost",
  "min_margin_bps",
  "supplier_account_id",
  "commission_account_id",
  "key_secret",
  "webhook_secret",
  "private_key",
];

function scanForLeaks(doc: string, raw: string): void {
  for (const field of NEVER_PUBLIC) {
    check(
      doc,
      `never publishes ${field}`,
      !raw.includes(field),
      raw.includes(field) ? "PRESENT IN A PUBLIC DOCUMENT" : "absent",
    );
  }
}

function isCents(v: unknown): boolean {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

async function getJson(path: string): Promise<{ raw: string; body: unknown; status: number }> {
  const res = await fetch(`${BASE}${path}`);
  const raw = await res.text();
  let body: unknown = undefined;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  return { raw, body, status: res.status };
}

/* ------------------------------------------------------------ agent card --- */

interface AgentCard {
  protocol_version?: unknown;
  name?: unknown;
  url?: unknown;
  capabilities?: unknown;
  authorization?: { model?: unknown; binds?: unknown; single_use_token?: unknown };
  constraints?: unknown;
  skills?: { id?: unknown }[];
  merchants?: { merchant_id?: unknown; feed?: unknown }[];
  endpoints?: Record<string, unknown>;
}

async function agentCard(): Promise<AgentCard | undefined> {
  const doc = "agent card";
  const { raw, body, status } = await getJson("/.well-known/agent.json");

  check(doc, "served at /.well-known/agent.json", status === 200, `HTTP ${status}`);
  if (status !== 200 || body === undefined) return undefined;

  const card = body as AgentCard;

  check(doc, "declares a protocol version", typeof card.protocol_version === "string",
    String(card.protocol_version));
  check(doc, "names itself and its origin",
    typeof card.name === "string" && typeof card.url === "string", String(card.url));
  check(doc, "declares capabilities", typeof card.capabilities === "object" && card.capabilities !== null,
    "present");

  // Authority is the half of the card a payments agent actually reads.
  const auth = card.authorization;
  check(doc, "declares its authorization model", auth?.model === "reserve_mandate",
    String(auth?.model));
  check(doc, "names what the mandate binds",
    Array.isArray(auth?.binds) && auth.binds.length > 0,
    Array.isArray(auth?.binds) ? auth.binds.join(", ") : "missing");
  check(doc, "declares a single-use settlement token", auth?.single_use_token === "intent_token",
    String(auth?.single_use_token));

  /*
   * The honest part. A card that lists only what a merchant *will* do is
   * marketing; the refusals are what let a buyer agent decide in advance
   * whether it can transact here at all.
   */
  const constraints = Array.isArray(card.constraints) ? (card.constraints as string[]) : [];
  check(doc, "publishes its refusals up front", constraints.length > 0,
    `${constraints.length} constraint(s)`);
  check(doc, "states that the buyer never sets a price",
    constraints.some((c) => /never sets a price|does not accept a price/iu.test(c)),
    constraints.find((c) => /price/iu.test(c)) ?? "NOT STATED");

  const skills = Array.isArray(card.skills) ? card.skills : [];
  const skillIds = skills.map((s) => String(s.id));
  for (const id of ["quote", "pay", "audit"]) {
    check(doc, `advertises the ${id} skill`, skillIds.includes(id), skillIds.join(", "));
  }

  const endpoints = card.endpoints ?? {};
  for (const key of ["quote", "pay", "mandate", "audit"]) {
    check(doc, `routes ${key}`, typeof endpoints[key] === "string", String(endpoints[key]));
  }

  const merchants = Array.isArray(card.merchants) ? card.merchants : [];
  check(doc, "lists at least one merchant", merchants.length > 0, `${merchants.length} merchant(s)`);
  check(doc, "links every merchant to its feed",
    merchants.every((m) => typeof m.feed === "string" && String(m.feed).includes("/api/feed/")),
    "all linked");

  scanForLeaks(doc, raw);
  return card;
}

/* ------------------------------------------------------------------ feed --- */

interface Feed {
  version?: unknown;
  currency?: unknown;
  minor_unit?: unknown;
  count?: unknown;
  merchant?: { id?: unknown; agent_card?: unknown };
  products?: {
    id?: unknown;
    title?: unknown;
    category?: unknown;
    price?: { amount?: unknown; currency?: unknown; minor_unit?: unknown };
    availability?: unknown;
    inventory_quantity?: unknown;
    min_order_quantity?: unknown;
  }[];
  negotiation?: { supported?: unknown; levers?: unknown };
}

async function feed(merchantId: string): Promise<void> {
  const doc = `feed ${merchantId}`;
  const { raw, body, status } = await getJson(`/api/feed/${merchantId}`);

  check(doc, "served", status === 200, `HTTP ${status}`);
  if (status !== 200 || body === undefined) return;

  const f = body as Feed;

  check(doc, "declares a feed version", typeof f.version === "string", String(f.version));
  check(doc, "names the merchant", f.merchant?.id === merchantId, String(f.merchant?.id));
  check(doc, "links back to the agent card",
    typeof f.merchant?.agent_card === "string", String(f.merchant?.agent_card));

  /*
   * Money, stated rather than assumed. "299" is meaningless without a currency
   * and a minor unit beside it, and a buyer agent that guesses will guess wrong
   * by a factor of a hundred exactly once.
   */
  check(doc, "declares a currency at the document level", f.currency === "USD", String(f.currency));
  check(doc, "declares its minor unit", f.minor_unit === "cents", String(f.minor_unit));

  const products = Array.isArray(f.products) ? f.products : [];
  check(doc, "carries products", products.length > 0, `${products.length} product(s)`);
  check(doc, "count matches the products served", f.count === products.length,
    `count=${String(f.count)} products=${products.length}`);

  const ids = products.map((p) => String(p.id));
  check(doc, "every product has a stable id", ids.every((id) => id !== "undefined" && id !== ""),
    "all present");
  check(doc, "ids are unique", new Set(ids).size === ids.length,
    `${new Set(ids).size} unique of ${ids.length}`);

  const badPrice = products.find((p) => !isCents(p.price?.amount));
  check(doc, "every price is an integer minor unit", badPrice === undefined,
    badPrice === undefined ? "all integer cents" : `${String(badPrice.id)} -> ${String(badPrice.price?.amount)}`);

  const badUnit = products.find(
    (p) => p.price?.currency !== "USD" || p.price?.minor_unit !== "cents",
  );
  check(doc, "every price restates its currency and unit", badUnit === undefined,
    badUnit === undefined ? "all explicit" : String(badUnit.id));

  // Availability from real stock, not a marketing flag.
  const badAvail = products.find(
    (p) =>
      (p.availability !== "in_stock" && p.availability !== "out_of_stock") ||
      !isCents(p.inventory_quantity) ||
      (p.availability === "in_stock") !== (Number(p.inventory_quantity) > 0),
  );
  check(doc, "availability agrees with inventory", badAvail === undefined,
    badAvail === undefined
      ? "all consistent"
      : `${String(badAvail.id)}: ${String(badAvail.availability)} at ${String(badAvail.inventory_quantity)}`);

  const badMoq = products.find((p) => !isCents(p.min_order_quantity) || Number(p.min_order_quantity) < 1);
  check(doc, "every line declares a minimum order quantity", badMoq === undefined,
    badMoq === undefined ? "all >= 1" : String(badMoq.id));

  check(doc, "states that it negotiates", f.negotiation?.supported === true,
    String(f.negotiation?.supported));
  check(doc, "publishes which levers it will pull", Array.isArray(f.negotiation?.levers),
    Array.isArray(f.negotiation?.levers) ? (f.negotiation.levers as string[]).join(", ") : "missing");

  scanForLeaks(doc, raw);
}

/* ------------------------------------------------------------------- run --- */

console.log(`\nMercury conformance -- ${BASE}`);
console.log("The Agent Card and the product feed, checked against the shape they claim.\n");

let card: AgentCard | undefined;
try {
  card = await agentCard();
} catch (e) {
  console.error(`Could not reach ${BASE}: ${(e as Error).message}`);
  console.error("Start the gateway first:  npm run dev\n");
  process.exit(2);
}

// Every merchant the card advertises must actually serve the feed it promises.
const merchants = (card?.merchants ?? []).map((m) => String(m.merchant_id));
for (const id of merchants) await feed(id);

// A merchant that does not exist must 404 rather than serve an empty catalogue.
// An empty feed reads as "we sell nothing"; a 404 reads as "no such merchant",
// and only one of those is true.
const missing = await getJson("/api/feed/mch_does_not_exist");
check("feed 404", "unknown merchant is a 404, not an empty catalogue", missing.status === 404,
  `HTTP ${missing.status}`);

let current = "";
for (const c of checks) {
  if (c.doc !== current) {
    current = c.doc;
    console.log(`\n${current}`);
  }
  const mark = c.passed ? `${GREEN}ok${OFF}` : `${RED}xx${OFF}`;
  console.log(`  ${mark} ${c.label} ${DIM}-- ${c.detail}${OFF}`);
}

const failed = checks.filter((c) => !c.passed);
console.log(
  `\n${failed.length === 0 ? GREEN : RED}${checks.length - failed.length}/${checks.length} checks passed${OFF}` +
    ` ${DIM}across ${merchants.length} merchant feed(s) and the agent card${OFF}\n`,
);

/*
 * `process.exitCode`, not `process.exit()`.
 *
 * Exiting outright while stdout is still draining aborts the process on
 * Windows -- libuv asserts on a handle that is already closing, and the run
 * ends with a crash dump after every check has passed. Setting the code lets
 * node finish writing and then leave with the status we asked for.
 */
process.exitCode = failed.length === 0 ? 0 : 1;
