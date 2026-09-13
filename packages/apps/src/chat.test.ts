import { describe, expect, it } from "vitest";
import { ChatError, FixtureChat, SlackChat, slackPayload } from "./chat.js";

const NOW = new Date("2026-09-14T09:00:00.000Z");
const approval = {
  kind: "approval_request" as const,
  text: "Needs your OK: $950.40 for 40 x Whole Bean Coffee 5lb",
  fields: [
    { label: "From", value: "manager@harborstreetcafe.test" },
    { label: "Why", value: "above the $600.00 you allowed the agent to spend on its own" },
  ],
  link: { label: "Approve or decline", url: "https://buy.stripe.com/test_FIX11" },
  idempotency_key: "approval:ses_1",
};

describe("FixtureChat", () => {
  it("posts once per idempotency key", async () => {
    const chat = new FixtureChat({ now: () => NOW });
    const a = await chat.post(approval);
    const b = await chat.post(approval);
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(b.id).toBe(a.id);
    expect(chat.posted()).toHaveLength(1);
    expect(chat.posted()[0]?.message.link?.url).toContain("stripe.com");
  });

  it("fails on demand, once, without recording the post", async () => {
    const chat = new FixtureChat();
    chat.failNext();
    await expect(chat.post(approval)).rejects.toThrow(ChatError);
    expect(chat.posted()).toHaveLength(0);
    expect((await chat.post(approval)).deduplicated).toBe(false);
  });
});

describe("SlackChat", () => {
  it("refuses anything that is not a Slack webhook URL", () => {
    expect(() => new SlackChat({ webhookUrl: "https://example.com/hook" })).toThrow(ChatError);
  });

  it("posts Block Kit to the webhook and dedupes in-process", async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response("ok", { status: 200 });
    };
    const chat = new SlackChat({ webhookUrl: "https://hooks.slack.com/services/T/B/x", fetchImpl, now: () => NOW });
    const a = await chat.post(approval);
    const b = await chat.post(approval);
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(bodies).toHaveLength(1);
    const payload = JSON.parse(bodies[0] ?? "{}") as { text: string; blocks: unknown[] };
    expect(payload.text).toBe(approval.text);
    expect(JSON.stringify(payload.blocks)).toContain("buy.stripe.com");
    expect(JSON.stringify(payload.blocks)).toContain("approval:ses_1");
  });

  it("surfaces a non-2xx as a ChatError, not a silent success", async () => {
    const fetchImpl: typeof fetch = async () => new Response("no_service", { status: 503 });
    const chat = new SlackChat({ webhookUrl: "https://hooks.slack.com/services/T/B/x", fetchImpl });
    await expect(chat.post(approval)).rejects.toThrow(/503/);
  });

  it("renders a summary without a link cleanly", () => {
    const p = slackPayload({ kind: "summary", text: "Paid $534.04", idempotency_key: "summary:ses_2" });
    expect(p.blocks).toHaveLength(2);
  });
});
