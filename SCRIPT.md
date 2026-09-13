# SCRIPT — the two-minute demo

> Two minutes, said out loud. Brackets are what you do. Plain text is what you
> say. Three beats, one idea each, and the whole thing hangs off a single email.

**The one line:**
*Email your AI what the café needs. It haggles, pays, books the delivery, logs
the order and sends you the receipt — but it can't spend a cent the rulebook
doesn't approve.*

**Say these words, not those words**

| Say | Not |
|---|---|
| the rulebook, the gate | the deterministic policy gate |
| the record, the ledger | the hash chain |
| the budget the owner signed | the mandate |
| it asks you first | step-up, human-in-the-loop |
| five apps | integrations, ports |
| a cent | 1 cent of drift, `DRIFT_BLOCKED` |

---

## Before you record

```bash
npm install
npm run seed        # fresh data, empty record
npm run dev         # opens on :3000
```

In a second terminal, with the server up:

```bash
npm run eval        # expect: 24 of 24 checks pass
```

One browser tab: `localhost:3000`. Press **Reset** once, so the record starts
empty on camera. Leave the composer prefilled — the demo email is already in it.

Everything runs in fixture mode with no credentials and no network. If you have
Stripe / Gmail / Slack / Calendar / Sheets set up in `.env`, the same three beats run
live; the strip says which apps are live in its top-right corner.

---

## 0:00 — Hook  *(10s)*

> [Mission Control. The composer on the left, the empty strip on the right.]

An AI is about to buy my café's coffee order — across five apps — in under a
minute. Watch for the one thing it's *not* allowed to do.

## 0:10 — Beat 1: one email, five apps  *(45s)*

> [Press **Send**. Say nothing for the first four or five seconds. Let the
> stations light up left to right.]

It read the email. It's haggling with the supplier's AI — and got a bulk price.
The rulebook re-priced the cart itself and checked my budget. Stripe paid.
Delivery's on my calendar, the order's in my purchase log, Slack got the
summary —

> [The last station lights: "receipt sent".]

— and there's my receipt. One email, five apps, forty seconds.

> [Point at the Stripe station.]

If that order had been over the amount I let it spend on its own, it would have
stopped right here and asked me on Slack instead. Nothing charged until I say
so.

## 0:55 — Beat 2: the lie  *(35s)*

> [Scroll to "Watch a purchase happen". Pick **The agent's arithmetic lies**.
> Press **Run it**.]

Now I make the AI cheat. Its own items add up to eleven dollars forty. It
claims eleven forty-one.

> [The gate panel on the right: "The agent said" vs "The gate charged". Point
> at the two figures.]

Refused. One cent apart. And look at the Stripe column — nothing. Stripe was
never called.

The AI's number is never used. The rulebook adds up the price list itself,
every time, and charges *its* figure. **The AI proposes. The rulebook decides.**

## 1:30 — Beat 3: tested, not trusted  *(20s)*

> [Click **What happens when it goes wrong**. Press **Run the whole table**.
> Rows go green.]

Eleven ways this breaks in real life, run right now. A fake payment
confirmation — thrown out. The same approval replayed — refused. And this one:
kill the process after the payment, restart it — one receipt, one charge, never
two.

> [The last line: "chain intact · N entries".]

## 1:50 — Close  *(10s)*

> [Back to the ledger panel. Press **Verify**. It passes.]

Every step in every app is one line in a record that just re-checked itself.
Mercury: an AI that buys for your business — and can prove it stayed in bounds.

---

## If a beat goes wrong on camera

- **The strip does not move.** The tab lost the event stream. Reload the page;
  the last run replays from the server, and Send works again.
- **A scenario is "blocked".** The bench is spent. Press **Reset**; it re-seeds
  in a second.
- **Beat 2 shows ALLOW.** You picked the wrong scenario. It is the one with
  **F1** beside it — "The agent's arithmetic lies".

## Numbers worth saying out loud

| Say this | Where it comes from |
|---|---|
| one email, five apps, about forty seconds | the strip's timestamps |
| $534.04, paid; the owner's ask-first line is $600 | the receipt; `mnd_restaurant_restock` |
| $11.41 said, $11.40 computed — one cent apart, refused before Stripe | the gate panel on the drift scenario |
| 24 of 24 checks, in about two seconds | `npm run eval` |
| 11 engineered failures, all verified live | the table |
| 271 automated tests, no API key needed | `npm test` |

## Don't say

- "Secure" or "unhackable". Say *bounded*, *checkable*, *never twice*.
- "Certified". We follow the AP2 / ACP shapes; we are not certified against them.
- "We process payments". Stripe moves the money. We decide whether it may.
- Any rule id. It is "the limit you set", "the budget the owner signed".

## The 30-second version

A café manager emails the purchasing agent. It haggles with the supplier's AI,
a rulebook — not the AI — re-prices the cart and checks the budget the owner
signed, Stripe pays, the delivery lands on Google Calendar, the order is logged
in the owner's Google Sheet, the team hears on Slack, the receipt comes back by
email. Over budget, it stops and asks. Every
step in every app is one line in a tamper-evident record. Eleven engineered
failures — a forged confirmation, a replayed approval, a process that dies after
paying — all verified live in two seconds. The AI proposes. The rulebook decides.
