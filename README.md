# Mercury

Submission for Multi-App AI Agent Hackathon, by LemmaAI, Comma Capital, Arga Labs and UserLens.
By Yash Raja (shoutout to claude code too!)

An AI purchasing agent for a small business that can't overspend.

You email it what you need. It haggles with the supplier's AI, pays with Stripe, puts the delivery on your Google Calendar, logs the order in your Google Sheet, tells your team on Slack, and emails you the receipt. If the order is over the budget you set, it stops and asks you first.

The key idea: the AI never decides if money moves. A plain rulebook (we call it the gate) re-prices every cart itself and checks it against the budget the owner signed. The AI can suggest. It can't spend.

```
Gmail  ->  supplier's agent  ->  the gate  ->  Stripe  ->  Google Calendar  ->  Google Sheets  ->  Slack  ->  Gmail
request     haggles              checks         pays        books delivery       logs the order     tells team   receipt
```

## A Quick Demo Video:

[main/Demo Video.mp4](https://github.com/yashraja01/Multi-App-AI-Agent-for-Commerce/blob/main/Demo%20Video.mp4)

## Try it yourself in two minutes

You need Node 22 or newer. Nothing else. No accounts, no API keys, no internet. Every app has an offline mode and the whole demo runs on your laptop.

```bash
git clone https://github.com/yashraja01/Multi-App-AI-Agent-for-Commerce.git
cd Multi-App-AI-Agent-for-Commerce
npm install
npm run seed
npm run dev
```

Open http://localhost:3000, press **Send** on the prefilled email, and watch the run cross five apps.

Then in a second terminal:

```bash
npm run eval
```

That runs every scenario, every failure drill, and a check on the ledger. It should print `24 of 24 checks pass` in about two seconds.

## What you're looking at

**One email, five apps** (top of the page). Type an email to the cafe's purchasing agent, press Send, and watch each step light up: Gmail reads it, the supplier's agent haggles, the gate approves, Stripe pays, Calendar books the delivery, Sheets logs it, Slack hears about it, Gmail sends the receipt.

Click "break something on purpose" to see what happens when things go wrong: the receipt bounces, Slack is down, or the process crashes right after paying. In that last one you get a **Restart the process** button, and the run finishes without sending anything twice.

**Watch a purchase happen.** The same run, narrated step by step. Try "The agent's arithmetic lies": the AI claims a total one cent off from its own items. The gate refuses it before Stripe is ever called.

**The gate** (right side). Two numbers: what the agent said, and what the gate charged. That's the whole idea in one panel.

**The ledger** (right side). Every step is written here and chained to the one before it. Press **Verify** and it re-checks the whole chain in front of you.

**What happens when it goes wrong.** Eleven real failures, injected and checked live: a forged payment confirmation, a replayed token, a dead Slack, a crash after payment, and more.

**The merchant page** at http://localhost:3000/merchant shows the supplier's side: what its agent earned and the rules it has to follow.

## How it works

**Every app follows the same pattern.** Each one (Stripe, Gmail, Slack, Google Calendar, Google Sheets) has a fake version for demos and a real one for production. One environment variable switches between them. The rest of the code can't tell the difference.

**The gate guards the money, and only the money.** The AI agent never has a payment key. The gate re-prices the cart from the price list, checks it against the owner's budget and the supplier's rules, and creates the order with its own number. The AI's number is thrown away. If an email bounces or Slack is down, that gets logged and retried, but it can never affect the payment.

**Nothing happens twice.** Before the agent sends an email or books a calendar slot, it writes down that it owes that action. If the process crashes, it picks up where it left off on restart. One receipt, one Slack post, one calendar entry, one log row. We tested this with a real `kill -9`.

**Everything is in the ledger.** Every step in every app becomes a line in a hash-chained record. The receipt even links to the audit trail for that specific order.

## How we know it works

| Command | What it checks |
|---|---|
| `npm test` | 271 unit tests. The gate, the ledger, the payment rail, the app connectors, the crash recovery. No API key needed. |
| `npm run eval` | 8 scenarios, 4 emails, 11 failure drills, and a ledger check. 24 checks in about 2 seconds. |
| `npm run chaos` | Just the 11 failure drills, with every check printed. |
| `npm run conformance` | 75 checks that the public product feed doesn't leak cost prices or supplier accounts. |
| `npm run verify` | Re-walks the ledger chain from the start. |

Honest note: the first time we ran `npm run eval`, it caught a bug. One scenario that was supposed to ask the owner for approval was actually being refused by a different rule first. It looked fine on screen. The report caught it.

What it doesn't do is in [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md).

## Going live

Copy `.env.example` to `.env` and fill in what you have. Each app is independent.

| App | Settings | What you need |
|---|---|---|
| Stripe | `RAIL_MODE=live`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | A test mode key (`sk_test_...`). Live keys are refused on purpose. |
| Gmail | `MAIL_MODE=gmail`, `GMAIL_USER`, `GMAIL_APP_PASSWORD` | A Gmail address for the agent and an app password. |
| Slack | `CHAT_MODE=slack`, `SLACK_WEBHOOK_URL` | One incoming webhook URL. |
| Google Calendar | `CALENDAR_MODE=google`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_ID` | A service account and a calendar shared with it. |
| Google Sheets | `SHEETS_MODE=google`, `GOOGLE_SHEET_ID` | The same service account and a spreadsheet shared with it. |

With Gmail on, the server checks the inbox every 15 seconds. Send the agent a real email and watch the page.

## Where things are

```
packages/core     money types, signing, schemas
packages/gate     the rulebook
packages/ledger   the hash-chained record
packages/store    SQLite, including the outbox
packages/rail     Stripe (fake and real)
packages/apps     Gmail, Slack, Google Calendar, Google Sheets (fake and real)
packages/agent    the negotiating agents and the engine
packages/seed     demo catalogs and budgets
apps/web          the website, the email intake, the APIs
apps/mcp          the merchant exposed as MCP tools for any AI buyer
scripts/          seed, demo, eval, chaos, conformance, verify
```

More detail: [CONTEXT.md](./CONTEXT.md) for the architecture, [DEVLOG.md](./DEVLOG.md) for decisions and what we found along the way, [SCRIPT.md](./SCRIPT.md) for the demo walkthrough.

## Protocols

Mercury follows the shapes of AP2 (mandates and human approval), ACP (single-use payment tokens) and UCP (product feeds), and publishes an A2A Agent Card at `/.well-known/agent.json`. It isn't certified against any of them. Stripe test mode only.
