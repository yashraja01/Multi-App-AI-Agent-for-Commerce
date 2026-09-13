# Known limitations

What this build does not do, said plainly. Each entry names the limit, why it
is there, and what it would take to remove it. Nothing here is hidden behind a
flag; every one of these is visible in the code it names.

## The apps

- **Live integrations are tested over fakes, not against real accounts.**
  `StripeRail`, `GmailMail`, `SlackChat`, `GoogleCalendar` and `GoogleSheet` each have
  transport tests over an injected `fetch` / IMAP / SMTP (the Google
  service-account JWT is verified with Node's own RSA verifier; a real MIME
  message is parsed). None has been run against a live account from this
  machine. The fixtures cover everything the demo shows. *To remove:* put the
  credentials in `.env` (see `.env.example`) and flip the five `*_MODE` vars.
- **Gmail uses an app password, not OAuth.** Right for a demo — two env vars,
  no consent screen — wrong for a product. *To remove:* an OAuth client and a
  refresh token; the port's surface does not change.
- **Approval is a link, not a Slack button.** Interactive Slack messages need a
  public callback URL. The link goes to the same page a button would have to
  end at; the channel is a notification surface. Nothing posted to chat is ever
  read back or treated as authority.
- **The delivery window is a stand-in.** Two days out, 09:00–11:00. The
  supplier feed does not carry a delivery promise yet.
- **One inbox, one business, one mandate.** `BUSINESS` in `intake.ts` hard-codes
  Harbor Street Café buying from Harbor Wholesale under
  `mnd_restaurant_restock`. This is a design choice as much as a limit — the
  sender must not be able to pick whose budget to spend — but a real deployment
  would map inbox → business in configuration.

## Money

- **Stripe test mode only.** `StripeRail` refuses any key that is not
  `sk_test_` / `rk_test_`. This is deliberate and permanent for this project.
- **Split settlement is fixture-only in practice.** The engine divides a
  wholesale capture across supplier accounts and the fixture records it; live
  transfers need Stripe Connect accounts (`acct_…`) that test mode does not
  provide out of the box.
- **Refunds after an unshippable order are automatic; failed transfers are
  not unwound.** A transfer leg that fails is recorded and left for an
  operator. This is the intended behaviour, and it is the kind of thing an
  operator should decide.

## Reading the request

- **`inferCart` is keyword matching.** Where a sentence becomes a cart, the
  scripted path uses a conservative matcher over catalogue titles. It
  under-reads rather than invents: "6 cases of oat milk" works, "half a dozen
  oat milks" does not, and the receipt says so. A misread costs a negotiation
  round, never money — the gate re-prices whatever is proposed. The Claude
  negotiator does not use it.
- **The Claude negotiator is exercised over a fake transport in CI and has
  not been run against the API from this fork.** The plumbing (tools, cached
  prefix, lever attribution) is covered by six tests; the model's judgement
  and the network call are not. `npm run demo -- --llm` with an
  `ANTHROPIC_API_KEY` is the check.

## The outbox and the drills

- **Retries are 3 attempts, 2s then 5s apart.** Demo pacing. A production
  outbox would back off for minutes and page someone.
- **The crash drill holds rows in process memory** (`crash_after_payment`),
  which is the state a real death leaves in the database without the death.
  A real `kill -9` and restart was also done by hand and resumed on boot; the
  drill exists so the same check can run in two seconds, every time.
- **The failure rows drive the clock by hand** (`drain(future)`) so the table
  does not wait for real backoff. The one thing that leaves untested is
  `setTimeout`, which the outbox unit tests cover.
- **The bench is finite.** The household mandate has 8 debits and the café's
  has 12; a full pass of the table spends one of each. Rows report *blocked*,
  not *failed*, when the bench is spent, and Reset re-seeds it.

## Infrastructure

- **One process, one SQLite file.** The outbox, the store and the ledger share
  a file, which is what makes the crash-recovery guarantee simple. It also
  means one instance. The ledger is tamper-*evident*, not tamper-*proof*
  against someone who controls the box.
- **The run bus is in memory.** `/api/events` replays the last 500 frames for
  a tab that arrives late, and nothing else. The ledger is the record; the bus
  is a live feed.
- **`npm audit` reports advisories from Next 15's own postcss/sharp.** Clearing
  them means Next 16, a framework major, out of scope for this build.

## Not attempted

- Reading the calendar or the sheet, moving or deleting events or rows, or any
  app action other than the one each port exists for. Sheets in particular is
  append-only: the owner's spreadsheet is their copy of the record, and the
  agent never edits it.
- Multi-tenant anything.
