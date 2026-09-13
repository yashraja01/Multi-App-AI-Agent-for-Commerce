import { describe, expect, it } from "vitest";
import { FixtureMail, GmailMail, type GmailTransports, MailError } from "./mail.js";

const NOW = new Date("2026-09-14T09:00:00.000Z");

describe("FixtureMail", () => {
  it("delivers an injected email exactly once", async () => {
    const mail = new FixtureMail({ now: () => NOW });
    const injected = mail.inject({ from: "manager@cafe.test", subject: "Restock", text: "10 bags of coffee" });
    expect(injected.to).toBe("agent@mercury.test");

    const first = await mail.pull();
    expect(first).toEqual([injected]);
    expect(await mail.pull()).toEqual([]);
  });

  it("sends, and refuses to send the same idempotency key twice", async () => {
    const mail = new FixtureMail({ now: () => NOW });
    const a = await mail.send({ to: "x@y", subject: "Receipt", text: "hi", idempotency_key: "receipt:pi_1" });
    const b = await mail.send({ to: "x@y", subject: "Receipt", text: "hi", idempotency_key: "receipt:pi_1" });
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(b.id).toBe(a.id);
    expect(mail.sent()).toHaveLength(1);
    expect(mail.sent()[0]?.text).toBe("hi");
  });

  it("bounces on demand, once, and does not record the failed send", async () => {
    const mail = new FixtureMail();
    mail.failNext("550 mailbox unavailable");
    await expect(
      mail.send({ to: "x@y", subject: "s", text: "t", idempotency_key: "k" }),
    ).rejects.toThrow(MailError);
    expect(mail.sent()).toHaveLength(0);
    const retry = await mail.send({ to: "x@y", subject: "s", text: "t", idempotency_key: "k" });
    expect(retry.deduplicated).toBe(false);
  });
});

describe("GmailMail", () => {
  function fakes() {
    const calls: string[] = [];
    const flagged: number[][] = [];
    const sent: unknown[] = [];
    const transports: GmailTransports = {
      imap: async () => ({
        connect: async () => {
          calls.push("connect");
        },
        logout: async () => {
          calls.push("logout");
        },
        getMailboxLock: async () => ({
          release: () => {
            calls.push("release");
          },
        }),
        search: async () => [7, 9],
        fetchAll: async () => [
          {
            uid: 9,
            envelope: {
              messageId: "<b@cafe>",
              subject: "Second",
              from: [{ address: "manager@cafe.test" }],
              to: [{ address: "agent@gmail.test" }],
            },
            source: Buffer.from(
              "From: manager@cafe.test\r\nTo: agent@gmail.test\r\nSubject: Second\r\nContent-Type: text/html\r\n\r\n<p>6 <b>cases</b> of oat milk</p>",
            ),
            internalDate: new Date("2026-09-14T09:05:00Z"),
          },
          {
            uid: 7,
            envelope: {
              messageId: "<a@cafe>",
              subject: "First",
              from: [{ address: "manager@cafe.test" }],
              to: [{ address: "agent@gmail.test" }],
            },
            source: Buffer.from(
              "From: manager@cafe.test\r\nTo: agent@gmail.test\r\nSubject: First\r\nContent-Type: text/plain\r\n\r\n10 bags of coffee beans\r\n",
            ),
            internalDate: new Date("2026-09-14T09:01:00Z"),
          },
        ],
        messageFlagsAdd: async (range: number[] | string) => {
          flagged.push(range as number[]);
          return true;
        },
      }),
      smtp: async () => ({
        sendMail: async (mail: unknown) => {
          sent.push(mail);
          return { messageId: "<sent-1@gmail>" };
        },
      }),
    };
    return { transports, calls, flagged, sent };
  }

  it("refuses to start without credentials", () => {
    expect(() => new GmailMail({ user: "", appPassword: "" })).toThrow(MailError);
  });

  it("reads unseen mail, oldest first, reduces HTML to text, then marks it seen", async () => {
    const f = fakes();
    const mail = new GmailMail({ user: "agent@gmail.test", appPassword: "app-pw", transports: f.transports });
    const inbox = await mail.pull();

    expect(inbox.map((m) => m.subject)).toEqual(["First", "Second"]);
    expect(inbox[0]?.text).toBe("10 bags of coffee beans");
    expect(inbox[1]?.text).toBe("6 cases of oat milk");
    expect(inbox[0]?.id).toBe("<a@cafe>");
    expect(f.flagged).toEqual([[7, 9]]);
    expect(f.calls).toEqual(["connect", "release", "logout"]);
  });

  it("sends with the idempotency key as a header and dedupes in-process", async () => {
    const f = fakes();
    const mail = new GmailMail({ user: "agent@gmail.test", appPassword: "app-pw", transports: f.transports });
    const a = await mail.send({ to: "manager@cafe.test", subject: "Re: Restock", text: "Done", idempotency_key: "receipt:pi_9", in_reply_to: "<a@cafe>" });
    const b = await mail.send({ to: "manager@cafe.test", subject: "Re: Restock", text: "Done", idempotency_key: "receipt:pi_9" });

    expect(a.id).toBe("<sent-1@gmail>");
    expect(b.deduplicated).toBe(true);
    expect(f.sent).toHaveLength(1);
    const m = f.sent[0] as { headers: Record<string, string>; inReplyTo?: string; from: string };
    expect(m.headers["X-Mercury-Idempotency-Key"]).toBe("receipt:pi_9");
    expect(m.inReplyTo).toBe("<a@cafe>");
    expect(m.from).toBe("agent@gmail.test");
  });
});
