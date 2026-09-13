# DEVLOG — Mercury (multi-app hackathon fork)

> Read **Start here next session** first if you are picking this up cold;
> read CONTEXT.md before that if you have never seen the project.
>
> This fork started on 2026-09-13 from the Razorpay Buildathon Mercury in the
> parent directory. That project's DEVLOG (61 KB of decisions, M0–M12) is the
> history of everything under `packages/`; it is not duplicated here. Its
> failure-audit table F1–F7 is what `npm run chaos` still verifies.
>
> The changelog is append-only, newest first. Everything above it is living
> state and should be edited in place. Stable project truth lives in
> CONTEXT.md — do not duplicate it here.

## The brief

A multi-app AI agent hackathon: a useful multi-step agent spanning three or
more external apps. Judged on technical execution (30%), reliability and
evaluation (25%), usefulness (20%), originality (15%), demo clarity (10%).
Judges are encouraged to see a successful run, the testing approach, and the
known limitations. The deliverable is a **2-minute demo**.

## Plan

| # | Step | Status | Notes |
|---|---|---|---|
| 0 | Copy into `LemmaAI-Hackathon/`, fresh install, baseline green | ☑ done | 232 tests, 7/7 chaos, 75/75 conformance, mcp:smoke — identical to the parent |
| 1 | Global rename: cents/USD, Gate/Ledger, café catalogues, new scenarios, UI, docs | ☑ done | See changelog entry H1 |
| 2 | `StripeRail` replaces the Razorpay live rail; `PaymentPort` naming; webhook scheme | ☑ done | See changelog entry H2. 238 tests |
| 3 | `MailPort` — Gmail in (IMAP) and out (SMTP), fixture + live | ☑ done | See changelog entry H3. 244 tests |
| 4 | `ChatPort` — Slack incoming webhook, fixture + live | ☑ done | See changelog entry H4. 250 tests |
| 5 | `CalendarPort` — Google Calendar via service account, fixture + live | ☑ done | See changelog entry H5. 256 tests |
| 6 | Outbox: idempotency key per app action, bounded retries, crash-safe resume | ☑ done | See changelog entry H6. 265 tests |
| 7 | Ledger events per app; "Across your apps" panel in Mission Control | ☑ done | See changelog entry H7 |
| 8 | Reliability Report: `npm run eval` + a panel; new chaos rows (email bounces, Slack down, calendar 500, crash after payment) | ☑ done | See changelog entry H8. 24/24 in ~2s |
| 9 | Model eval over the scenario set (needs `ANTHROPIC_API_KEY`) | ☐ | Lower priority; written evidence, not in the video |
| 10 | `KNOWN_LIMITATIONS.md`; new SCRIPT.md (2 minutes); judge-facing README | ☑ done | See changelog entry H10 |
| 11 | Stretch: Google Sheets purchase log | ☑ done | See changelog entry H11. 271 tests |

**CONTEXT.md describes the target state.** In section 13 (app ports) the
section 13 is now true of the code, outbox included; in section 14 the
"Across your apps" panel is built and the "Reliability" panel is step 8. The "Across your apps" / "Reliability" panels in section 14 are steps 7–8.
Everything else in CONTEXT.md is true of the code today.

## Start here next session

**State:** every step but 9 complete (0–8, 10, 11). The codebase is global, Stripe is the rail,
and the first app port is in: an email to the agent's inbox becomes a
negotiation, a gate decision, a payment and a receipt, with `EMAIL_RECEIVED`
and `EMAIL_SENT` in the chain around them; a step-up posts an approval request
to the team's channel and every run posts a one-line summary (`CHAT_POSTED`);
a paid order books its delivery window on the calendar
(`CALENDAR_EVENT_CREATED`). All four apps are in, and every app action goes
through the outbox: owed before attempted, retried within a bound, finished on
restart, never twice. Mission Control opens on the "One email, four apps"
panel: a composer prefilled with the demo email, four failure drills behind
"break something on purpose", and the run drawn as seven stations on a ruled
line that light up from the run bus. `npm run eval` is the Reliability Report:
8 bench scenarios × expected outcome, 4 emails, 11 failure drills, the chain —
24 checks, green in about two seconds. `README.md` is the judge-facing entry,
`SCRIPT.md` the two-minute demo, `KNOWN_LIMITATIONS.md` the honest list.
Google Sheets is the fifth app: one row per paid order in the owner's own
spreadsheet, eighth station on the strip. Remaining: step 9 (model eval, needs
an `ANTHROPIC_API_KEY`), and the video.

`node scripts/shot.mjs <url> <out.png> [waitMs] [w] [h]` screenshots a page
with headless Edge over the DevTools protocol — the Chrome extension was not
available on this machine and `--screenshot` captures before the client has
fetched anything.

The demo run's chain, end to end:
`EMAIL_RECEIVED → OFFER_PROPOSED → GATE_DECISION → ORDER_CREATED → BASKET_VALUED →
PAYMENT_CAPTURED → SETTLEMENT_SPLIT → REPLAY_BLOCKED → CALENDAR_EVENT_CREATED →
CHAT_POSTED → EMAIL_SENT`.

**The email path, checked in two commands** (needs `npm run dev`):

```bash
curl -s -XPOST localhost:3000/api/intake/email -H 'content-type: application/json'   -d '{"from":"manager@harborstreetcafe.test","subject":"Restock for next week","text":"10 bags of coffee beans and 6 cases of oat milk please"}'
# expect processed[0].result "captured", amount_cents 53404, receipt.subject "Re: Restock for next week"
curl -s localhost:3000/api/intake/email      # the fixture's Sent folder, receipt text included
# "40 bags of coffee beans" -> result "step_up" ($950.40 > the $600 ask-first threshold, nothing charged)
# "send me last month's invoice" -> result "denied", with a reason that says no product was found
# add "bounce_receipt": true -> payment captured, receipt bounces, APP_ACTION_FAILED recorded, payment stands
# add "fail_chat": true      -> payment captured, Slack post fails, APP_ACTION_FAILED recorded, receipt still sent
# add "fail_calendar": true  -> payment captured, calendar fails once, retried after 2s, CALENDAR_EVENT_CREATED with attempts 2
# add "crash_after_payment": true -> payment captured; the three app actions sit pending in the outbox, nothing sent
#   then: kill the dev server, start it again -> "[outbox] resumed 3 pending action(s)"; each done once
#   or:   curl -s -XPOST localhost:3000/api/ops/outbox -d '{"action":"release"}'   (the restart, without restarting)
# GET /api/ops/outbox            -> what is owed, done and failed
# GET also lists the fixture channel's posts (approval requests with the link; summaries with the audit link)
```

`GET /api/events?since=0` streams every run's events (button, email or MCP)
as SSE from an in-memory ring; the "Across your apps" panel will read it.

**Sanity check before writing code:**

```bash
npm install && npm run build && npm test    # expect 271 passed
npm run seed && npm run demo                # both verticals, terminal
npm run dev                                 # then, elsewhere:
npm run eval                                # expect 24 of 24 checks pass (re-seeds first)
npm run chaos -- --reset                    # expect 11/11 rows verified
npm run mcp:smoke
npm run conformance                         # expect 75/75 checks
```

**Numbers worth knowing (new seed):**

```bash
curl -s -XPOST localhost:3000/api/negotiate -H 'content-type: application/json' \
  -d '{"scenario":"bulk","mode":"scripted"}' >/dev/null
curl -s 'localhost:3000/api/merchant/summary?merchant_id=mch_bulk'
# expect baseline_cents 31860, final_cents 33664, uplift_cents 1804, uplift_bps 566, levers [bulk_tier]
```

The bulk order (10 bags of coffee, 6 cartons of cups) lists at $318.60 and the
agent closes it at $336.64 with the bulk tier — $18.04 (5.66%) over a flat
price list. The demo bench costs $5.70 and one debit per full chaos pass.

**Known gaps, stated plainly:**

- `GmailMail` is tested over fake IMAP/SMTP transports (including a real MIME
  parse) but has not been run against a real Gmail account. Fixture mail covers
  the demo. Live Gmail uses an app password, not OAuth.
- The intake reads the email body with `inferCart`, the same keyword matcher as
  every buyer message. It under-reads rather than invents, and the receipt says
  when nothing matched.
- The crash drill's `crash_after_payment` flag holds the run's outbox rows in
  process memory; a real `kill -9` was also done by hand and resumed on boot
  (see H6). Both paths are the same code: `drain()`.
- Outbox retries are 3 attempts, 2s then 5s apart — demo pacing, not
  production pacing.
- `GoogleCalendar` and `SlackChat` are tested over fake `fetch` (the
  service-account JWT is verified with Node's own RSA verifier) but have not
  been run against real accounts.
- The delivery window is a stand-in: two days out, 09:00–11:00. The supplier
  feed does not carry a delivery promise yet.
- `StripeRail` has transport tests over a fake `fetch` but has not been run
  against a real `sk_test_` key. The fixture covers everything the demo shows.
- Live split settlement needs Stripe Connect accounts test mode does not have
  out of the box; that leg is fixture-verified only.
- `inferCart` is keyword matching where buyer intent enters the system. It fails
  safe — a misread costs a negotiation round, never money — and the LLM path
  does not use it.
- `LlmRevenueAgent` is exercised in CI over a fake transport; the network call
  and the model's judgement are unproven on this fork until step 9.
- `npm audit` reports advisories from Next 15's own postcss/sharp. Clearing them
  means Next 16, a framework major.

## Decisions

| # | Decision | Why |
|---|---|---|
| H1 | Re-price the seed by exactly ÷100 (₹600 → $6.00), not by picking new numbers | Every ratio the gate reasons about — margin floor, discount ceiling, which cap binds first — is unchanged, so the scenarios still reach the outcomes they were designed to reach and every chaos row still passes without re-tuning. Tests were left arithmetic-identical by renaming `rupees()` → `dollars()` and keeping their literals |
| H2 | `Gate` / `Ledger` as package and type names; "the gate" / "the ledger" in prose | Proper-noun "Dwaar"/"Sakshi" needed a glossary for a non-Indian audience. Plain English nouns do not |
| H3 | `ReserveMandate` → `BudgetMandate`; drop UPI Reserve Pay from the docs, keep AP2 / ACP / UCP | The UPI primitive is India-only; the AP2 Intent Mandate and ACP delegated payment are the global shapes, and ACP is Stripe's own |
| H4 | Keep `mch_quick` / `mch_bulk`, `quick_commerce` / `b2b_procurement`, `mode: "route"` | Neutral identifiers that appear in dozens of tests and fixtures; renaming them buys nothing a judge would see |
| H5 | Café restock is the demo hero; the B2C grocer stays as the second vertical | One email from a café manager is the simplest possible story, and the "one gate, two businesses" claim still lands |
| H6 | Rail types stay Mercury's own (`RailOrder`, `RailPayment`…); `StripeRail` is an adapter | The engine, store, ledger and UI never learned Stripe's vocabulary, so a second provider is one more adapter, not a rewrite. The fixture produces the same types directly |
| H7 | Webhook bodies are Stripe-shaped in *both* rails; the fixture signs with Stripe's `t=…,v1=…` scheme | The forged- and duplicate-webhook drills are only honest if the request they fire is one Stripe could have sent. A fixture-only envelope format would have proved nothing about the real route |
| H8 | `PaymentPort.attemptPayment` replaces the engine's fixture-only `simulate` callback; the "checkout signature" is gone | Razorpay's browser checkout handed back a client-side signature to verify. Stripe's server-side confirm is an authenticated API call, so the untrusted inbound channel is the webhook alone. This also makes live mode a real code path for the first time — the old engine returned "no payment simulator supplied (live mode is M8)" |
| H10 | One inbox, one business, one mandate (`BUSINESS` in `intake.ts`); the sender picks nothing but the goods | The email is a request, not instructions. Letting a sender name a merchant or mandate would make the inbox a way to spend someone else's budget; letting it name a price is the thing the whole system forbids |
| H11 | Every outbound email carries an idempotency key `receipt:<run_id>`; the port dedupes on it | Step 6's outbox will retry sends after a crash. A retry that produced a second receipt would be the multi-app version of a double charge |
| H12 | A bounced receipt is `APP_ACTION_FAILED` in the ledger and never touches the payment | The gate stands in front of money and only money. Mail is owed, not authoritative |
| H13 | An in-memory run bus plus `/api/events` (SSE) rather than persisting theatre events | A run an email starts has no browser request to stream back on. The bus is a live feed for open tabs; the ledger stays the only record |
| H14 | `appAction()` in `lib/apps.ts` wraps every external-app call: success → the named ledger event, failure → `APP_ACTION_FAILED`, both narrated on the bus, nothing thrown past it | Three apps, one contract. Each port author would otherwise have to remember that a failed post must not unwind a payment; now the only way to call an app is the way that guarantees it. Step 6's outbox slots in behind this function |
| H15 | Chat is told, never asked. Approval is the link, not a reply in the channel | A Slack reply is unauthenticated text. The link goes to a page that runs the gate's step-up; the channel is a notification surface. Interactive buttons would need a public callback URL and would still have to end at the same link |
| H16 | Google via a service account and two hand-rolled HTTP calls (RS256 JWT → token → `events.insert`), not the googleapis SDK | The SDK is ~100 packages for two endpoints. The JWT is twelve lines of `node:crypto` and is tested against Node's own verifier. Same credential will serve Sheets if we do the stretch |
| H17 | The calendar is written only for a *captured* order, and only ever `insert` | A step-up has not been released and a denial bought nothing; booking either would put a promise on the calendar the gate never made. The agent never reads, moves or deletes an event |
| H18 | The outbox is a table in the *same* SQLite file as the orders, written before the action is attempted | The debt and the payment share a durability boundary. A queue in another process could be lost while the payment survived, and then nobody would know a receipt was owed |
| H19 | Three layers of exactly-once: the outbox row (survives a restart), the port's in-process dedupe (survives a retry), the idempotency key on the wire (survives a provider retry) | Each layer covers a failure the others cannot: the process dying, the same process retrying, the provider retrying us. Only the first survives a restart, which is why it is the one in the database |
| H20 | `server-only` is aliased to its own `empty.js` under vitest, so `apps/web/lib` is testable | The guard exists to keep the engine out of a browser bundle. Under Node it guards nothing and only stopped the crash drill from having a test |
| H21 | The strip is a pure function of the run bus (`stationsOf(events)`), and the bus carries the same events the theatre narrates | One source, two readings: the strip is the summary a judge watches, the theatre is the narration. Neither is a second implementation of what happened |
| H22 | `MERCURY_PACE_MS` (default 350) paces the intake's bus events; zero under test | The work is instantaneous; a person watching is not. Pacing is presentation and lives in one place, and nothing in the money path waits on it |
| H23 | The composer's four failure drills are checkboxes behind a link, not buttons on the surface | The demo opens on a working run. The drills are the third beat; putting them on the surface would make the first screen a fault-injection console rather than an inbox |
| H24 | The app failure rows (F8–F11) drive `processEmail` in-process with `noPace`, but the intake, outbox and ports they exercise are the production path; only the clock is driven by hand (`drain(future)`) | Waiting 2s and 5s per retry would make the table take a minute. Driving the clock tests the same code with the same rows; the one thing not tested is `setTimeout`, which the unit tests cover |
| H25 | `npm run eval` checks each bench scenario against the outcome it *claims* to reach, not just that it ran | The bench is a set of claims about the gate. The first run of the report found one of them false: the "above the approval threshold" scenario had been refused by the per-order cap ($21.40 > $20) before the approval line was consulted, since the ÷100 re-pricing. Nobody had noticed because it still looked like a refusal |
| H9 | `payment_method` is chosen by the scenario, never by any buyer-facing API; the buyer API's `simulate_failure` flag is fixture-only and holder-bound | The same rule as prices. The one knob a buyer has is to decline its *own* fixture payment, to exercise the retry path; it cannot name a method, and in live mode the flag is ignored |

## Changelog

### H11 — Google Sheets: the owner's purchase log (2026-09-14)

- `packages/apps/src/google.ts`: `GoogleAuth` (service-account JWT → token,
  cached per scope) extracted from the calendar port; both Google ports use it.
- `packages/apps/src/sheet.ts`: `SheetPort` with `FixtureSheet` (`rows()`,
  `failNext()`) and `GoogleSheet` (`values:append` on one tab,
  `USER_ENTERED`, reports the landed range). Columns: Date, Order, Supplier,
  Items, Amount (dollars), Requested by, Audit trail. Append-only by design.
  6 tests.
- Ledger: `SHEET_ROW_APPENDED`. Outbox: `google_sheets` / `log_purchase`
  payload. Intake: `logPurchase()` after the calendar, only for a paid order.
- Strip: eighth station "Google Sheets · logs the purchase"; header "One
  email, five apps"; `fail_sheet` drill. F9 and F11 assert the log row; F11
  now owes four actions. `npm run eval` checks "purchase logged".
- Env: `SHEETS_MODE`, `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_TAB`.
- Result: typecheck clean, 271/271 tests, eval 24/24, chaos 11/11, docs
  updated to five apps.

### H10 — the documents (2026-09-14)

- `README.md`: judge-facing. The one line, the seven-station diagram, run it
  in two minutes, what to look at, how it holds together (four apps one
  pattern / the gate in front of money only / owed before attempted / every
  step in the ledger), the reliability table with what each command proves,
  going live, repo map, protocols.
- `SCRIPT.md`: the two-minute demo — hook, one email four apps (45s), the lie
  (35s), tested not trusted (20s), close — with what to say and not say, the
  figures to say aloud ($534.04 paid; $11.41 said vs $11.40 computed; 24/24;
  11 drills; 265 tests), and what to do if a beat goes wrong. Now tracked.
- `KNOWN_LIMITATIONS.md`: apps, money, reading the request, the outbox and
  drills, infrastructure, not attempted — each with why and what would remove
  it.

### H8 — the Reliability Report (2026-09-14)

- Chaos rows **F8 receipt bounces** (retried, sent on attempt 2, one capture),
  **F9 Slack is down** (three attempts, `APP_ACTION_FAILED`, receipt and
  calendar still go), **F10 nothing to buy** (no order, nothing charged, an
  honest reply), **F11 crash after payment** (three owed, none out; release →
  each exactly once; second release empty). They run through `processEmail`
  with `noPace`, spend the café's envelope (bumped to 12 debits), and have their
  own bench preflight. Fixtures gained `failNext(reason, times)`.
- `scripts/eval.ts` / `npm run eval`: re-seeds, then 8 scenarios × expected
  outcome over the SSE route, 4 emails through the intake, 11 drills over
  `/api/chaos`, chain verify; a `fast: true` flag on the negotiate and intake
  routes skips presentation beats. Exits non-zero on any red.
- Found and fixed: the `stepup` bench scenario (3 oat milk + juice = $21.40)
  hit `MANDATE.PER_TXN_CAP` before the approval threshold; now 2 + juice =
  $15.40.
- Chaos Console retitled "Tested, not trusted"; F1–F11; "Run the whole table"
  ends with a live chain verify shown inline.
- `scripts/shot.mjs` can click a sequence of buttons before capturing.
- Result: typecheck clean, 265/265 tests, `npm run eval` 24/24 in ~2s, 11/11
  chaos, 75/75 conformance, `mcp:smoke`, build green.

### H7 — "One email, four apps": the strip (2026-09-14)

- `apps/web/components/AcrossApps.tsx`: the composer (From / Subject / body,
  underlined fields, prefilled with the demo email; four drills behind "break
  something on purpose") and the strip — seven stations on a ruled line
  (Gmail · Supplier's agent · The gate · Stripe · Google Calendar · Slack ·
  Gmail), each with the app, its job, one line of result and a clock time.
  Dot states: idle / waiting (pulse) / done (paper) / warn (brass) / fail
  (vermilion) / owed (dashed brass, the crash drill). Footer: outbox counts
  and, when a run is held, "Restart the process".
- Mission Control subscribes to `/api/events`; email-run frames feed the strip
  and the theatre; `done`/`app` frames refresh state and ledger. New headline
  copy. Panels below fixed at 720px.
- `/api/state` carries `apps` modes, `business`, and `outbox` counts;
  `BusEvent` type moved to `lib/types.ts`; ledger tones for the app events.
- Intake paces its bus events (`MERCURY_PACE_MS`); outbox narrations shortened
  for the strip ("delivery booked for Sep 15 — on attempt 2").
- `scripts/shot.mjs`: headless-Edge screenshots over CDP.
- Result: typecheck clean, 265/265 tests, 7/7 chaos, 75/75 conformance,
  `mcp:smoke`, build green; Mission Control and the merchant console render.

### H6 — the outbox: owed, retried, finished on restart, never twice (2026-09-14)

- Store: `outbox` table (`idempotency_key` PK, run, app, action, payload,
  status pending|done|failed, attempts, last_error, result, next_attempt_at)
  with `enqueueOutbox` / `dueOutbox` / `completeOutbox` / `failOutbox` /
  `listOutbox`. 4 tests.
- `apps/web/lib/outbox.ts`: `owe()` writes the row then attempts it; `drain()`
  attempts every due row once and arms a timer for the next; `attempt()` maps
  success to the named ledger event and exhaustion to `APP_ACTION_FAILED`;
  `holdRun()` / `release()` are the crash drill; `resumeOnBoot()` drains on
  `mercury()` build; `stopOutbox()` before the database closes. MAX_ATTEMPTS
  3, backoff 2s / 5s. Payloads are self-contained (`OutboundEmail`,
  `ChatMessage`, `CalendarEventInput`) so a row can be performed by a process
  that never saw the run.
- `appAction()` is now a thin wrapper over `owe()`; the intake's four calls
  pass payloads instead of closures.
- Routes: `crash_after_payment` on the intake; `GET/POST /api/ops/outbox`.
- `vitest.config.ts` aliases `server-only`; `apps/web/lib/outbox.test.ts`
  (5 tests, real SQLite, fixture ports): owe once, owe again is a no-op, hold →
  release → exactly once → release again is empty, three failures → failed +
  `APP_ACTION_FAILED`, failure then success → done with attempts 2.
- Verified by hand against the dev server: crash drill held 3 rows, `kill -9`,
  restart logged `[outbox] resumed 3 pending action(s)`, ledger shows one
  `PAYMENT_CAPTURED`, one `CALENDAR_EVENT_CREATED`, one `CHAT_POSTED`, one
  `EMAIL_SENT` for the run; a calendar that fails once is retried after 2s and
  recorded with `attempts: 2`.
- Result: typecheck clean, 265/265 tests, 7/7 chaos, 75/75 conformance,
  `mcp:smoke`, demo, build green.

### H5 — CalendarPort: the delivery goes on the calendar (2026-09-14)

- `packages/apps/src/calendar.ts`: `CalendarPort` with `FixtureCalendar`
  (`failNext()`, `events()`) and `GoogleCalendar` (service-account JWT signed
  with `node:crypto`, token exchange cached until a minute before expiry,
  `events.insert` with the order id in `extendedProperties.private`). 6 tests.
- Intake: `bookDelivery()` after a capture — "Delivery — Harbor Wholesale
  Supply", items in the description, two days out, 09:00–11:00, idempotent on
  `delivery:<run_id>`; the receipt's "Delivery is on the calendar for …" line
  is back, and only appears when the event exists. Order of app actions:
  calendar, chat, mail — each through `appAction()`, each independent.
- Route: `fail_calendar` drill flag; `GET /api/intake/email` lists events.
- Env: `CALENDAR_MODE`, `GOOGLE_SERVICE_ACCOUNT_JSON` (inline or a path),
  `GOOGLE_CALENDAR_ID`.
- Result: typecheck clean, 256/256 tests, 7/7 chaos, 75/75 conformance,
  `mcp:smoke` green. Calendar down → payment captured, `APP_ACTION_FAILED`,
  Slack summary and receipt still go.

### H4 — ChatPort: Slack approval requests and summaries (2026-09-14)

- `packages/apps/src/chat.ts`: `ChatPort` with `FixtureChat` (in-memory
  channel, `failNext()`, `posted()`) and `SlackChat` (one incoming-webhook URL,
  Block Kit payload, non-2xx → `ChatError`, refuses non-Slack URLs). 6 tests.
- `apps/web/lib/apps.ts`: `appAction()` — the one way to call an external app.
  Records success as the named event and failure as `APP_ACTION_FAILED`;
  publishes a theatre `app` event either way; never throws.
- Intake: on step-up, an **approval request** ("Needs your OK: $950.40 for 40 x
  Whole Bean Coffee 5lb", why, "Charged so far: $0.00", the link); after every
  run a **summary** with the audit link. Chat before mail; each independent.
  The receipt send moved onto `appAction()`.
- Theatre renders `app` events (gmail / slack / calendar markers, green or red).
- Route: `fail_chat` drill flag; `GET /api/intake/email` lists the channel.
- Env: `CHAT_MODE`, `SLACK_WEBHOOK_URL`.
- Result: typecheck clean, 250/250 tests, 7/7 chaos, 75/75 conformance,
  `mcp:smoke` green. Slack down → payment captured, `APP_ACTION_FAILED`,
  receipt still sent.

### H3 — MailPort: an email becomes a purchase (2026-09-14)

- New package `@mercury/apps` (`packages/apps`): `MailPort` with `FixtureMail`
  (in-memory inbox/outbox, `inject()`, `failNext()`, `sent()`) and `GmailMail`
  (IMAP unseen → text via `mailparser`, mark seen after fetch; SMTP with an
  `X-Mercury-Idempotency-Key` header and `In-Reply-To`). Transports are
  injectable; 6 tests.
- Ledger: `EMAIL_RECEIVED`, `EMAIL_SENT`, `CHAT_POSTED`, `CALENDAR_EVENT_CREATED`,
  `APP_ACTION_FAILED` event types; `"app"` actor type.
- `apps/web/lib/intake.ts`: `processEmail` logs the receipt of the mail, runs
  the ordinary `runScenario` path under the same session id (so
  `/api/agent/audit?session_id=` returns the whole run), composes a plain-English
  receipt for captured / step-up / denied / failed, sends it, logs it.
  `BUSINESS` = Harbor Street Café buying from Harbor Wholesale under
  `mnd_restaurant_restock`.
- `runScenario(…, { sessionId })`; `ScenarioId` gains `"intake"`.
- Routes: `POST /api/intake/email` (inject + pull + process in fixture mode,
  pull-now in live; `bounce_receipt` for the failure drill), `GET` shows the
  Sent folder; `GET /api/events` SSE from the new run bus (`lib/bus.ts`).
- `lib/mail-poller.ts`: one `setInterval` per process in Gmail mode.
- Env: `MAIL_MODE`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `MAIL_POLL_SECONDS`.
- Result: typecheck clean, 244/244 tests, 7/7 chaos, 75/75 conformance,
  `mcp:smoke`, demo and verify green. The demo email ("10 bags of coffee beans
  and 6 cases of oat milk") captures $534.04 and gets a receipt; "40 bags"
  gets an approval request; a question gets an honest refusal.

### H2 — Stripe replaces Razorpay (2026-09-14)

- `packages/rail`: `RazorpayPort` → `PaymentPort`; `Rzp*` → `Rail*` types;
  `LiveRail` (Razorpay) deleted, `StripeRail` added (PaymentIntents with manual
  capture, confirm with a test `pm_…`, capture, refunds, Connect transfers,
  payment links; form-encoded `fetch`; `sk_test_` guard; 402 decline handled as
  a failed attempt). New `shapes.ts` maps Stripe ↔ rail entities both ways.
- Signatures: `Stripe-Signature: t=…,v1=…` over `${t}.${body}`, tolerance
  window, multiple `v1` accepted, constant-time compare. Checkout signatures
  removed (no client-side checkout in this flow).
- Webhooks: the gate parses Stripe events, normalises `charge.*`,
  `payment_intent.succeeded`, `transfer.created` onto Mercury's event names,
  dedupes on the `evt_…` id in the body. Route moved to `/api/webhook/stripe`.
- Engine: `settle({ payment_method, onAttempt })` drives `rail.attemptPayment`
  → `rail.capturePayment` in both modes; `simulate`/`vpa` gone. Ledger field
  `razorpay` → `provider`, actor type `"razorpay"` → `"rail"`.
- Fixture ids: `pi_FIX…`, `ch_FIX…`, `re_FIX…`, `tr_FIX…`, `plink_FIX…`,
  `evt_FIX…`; test methods `pm_card_visa` / `pm_card_chargeDeclined`.
- Chaos F4/F5 build Stripe charge events and post them to the Stripe route;
  env is `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`.
- Result: typecheck clean, 238/238 tests (34 in rail, up from 28), 7/7 chaos,
  75/75 conformance, `mcp:smoke` green, demo and verify green.

### H1 — Global rename (2026-09-13)

- `Paise` → `Cents`, `paise()` → `cents()`, `rupees()` → `dollars()`,
  `formatINR` → `formatUSD`; `en-IN` → `en-US`; all `*_paise` fields → `*_cents`.
- `packages/dwaar` → `packages/gate` (`@mercury/gate`), `packages/sakshi` →
  `packages/ledger` (`@mercury/ledger`); `Sakshi` class → `Ledger`,
  `SakshiEntry` → `LedgerEntry`, `DWAAR_DECISION` → `GATE_DECISION`,
  actor type `"dwaar"` → `"gate"`. `DwaarPanel` → `GatePanel`, `SakshiPanel` →
  `LedgerPanel`. Devanagari font and labels removed from the UI.
- `ReserveMandate` → `BudgetMandate` (and the `zBudgetMandate` / signed forms).
- New catalogues: **Corner Fresh Market** (oat milk, sourdough, bananas, pasta,
  green tea, orange juice, granola, dish soap, olive oil) and **Harbor Wholesale
  Supply** (coffee 5lb, flour, canola oil, oat-milk cases, tea bags, cups,
  napkins). Suppliers `acc_HARBOR_FOODS`, `acc_BAYSIDE_PACKAGING`. Prices ÷100.
- Mandates ÷100: household $50 / $20 / ask above $15; restaurant $3,000 /
  $1,500 / ask above $600. Merchant caps $200 and $2,000.
- `inferCart` stop-list extended with `case(s)`, `jug(s)`, `loaf/loaves`,
  `bunch(es)`, `all`, `bean(s)` so "6 cases of oat milk" and "10 bags of coffee
  beans" parse to the right quantity.
- Scenario buyer lines, chaos bench costs (`RUN_COST` $5.70, `ROW_COST` $6.00),
  demo and smoke scripts, prompts, MCP descriptions all rewritten for the new
  goods. Merchant console money control steps by $50.
- Result: 232/232 tests, 7/7 chaos, 75/75 conformance, `mcp:smoke` green;
  Mission Control and the merchant console render with no leftover terms.
