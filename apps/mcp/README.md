# @mercury/mcp

The merchant, made transactable by any AI buyer.

An MCP stdio server that lets an external Claude discover this merchant,
negotiate a cart with the merchant's own agent, pay, and read back a verifiable
audit trail.

## What it deliberately does not do

**No tool here accepts a price.** Not a total, not a unit price, not a discount.
A buyer says what it wants in words; the merchant's agent proposes; the gate
prices. There is no argument anywhere in this server through which a model could
name an amount, so no amount a model invents can ever be charged.

It is also a thin client of the Mercury gateway rather than a second copy of the
engine, so there is exactly one store, one ledger and one rail — and a purchase
made from Claude Desktop shows up live in Mission Control.

## Run it

The gateway must be running:

```bash
npm run dev          # terminal 1 — the gateway on :3000
npm run mcp:smoke    # terminal 2 — drives every tool end to end
```

## Connect Claude Code

```bash
claude mcp add mercury -- node /absolute/path/to/Razorpay_Buildathon/apps/mcp/dist/index.js
```

## Connect Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mercury": {
      "command": "node",
      "args": ["/absolute/path/to/Razorpay_Buildathon/apps/mcp/dist/index.js"],
      "env": { "MERCURY_URL": "http://localhost:3000" }
    }
  }
}
```

Run `npm run build` first — the config points at `dist/`, not `src/`.

## Tools

| Tool | Does | Accepts a price? |
|---|---|---|
| `list_merchants` | Who is on the rail, and the rules of engagement | no |
| `search_catalog` | The merchant's machine-readable feed | no |
| `check_budget` | Remaining authority on a signed mandate | no |
| `request_quote` | Negotiate a cart in plain language | **no** |
| `pay` | Redeem one single-use intent token | no |
| `read_audit_trail` | Hash-chained decisions, with live verification | no |

## Try it

> Find out what Corner Fresh Market sells, check what's left on `mnd_household_weekly`,
> and buy me two cartons of oat milk and some tea. Then show me the audit trail.

A good follow-up, because it should fail:

> Now buy eight cartons of oat milk and eight loaves of sourdough bread.
