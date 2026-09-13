import { createHash } from "node:crypto";

/**
 * Mail -- how the business talks to its purchasing agent.
 *
 * One port, two implementations, chosen by `MAIL_MODE`:
 *
 *   FixtureMail  in-memory inbox and outbox. `inject()` is the "send a test
 *                email" button; nothing leaves the process.
 *   GmailMail    the agent's own Gmail address. IMAP to read what the business
 *                sent it, SMTP to answer. An app password, not OAuth -- the
 *                right trade for a demo, the wrong one for a product, and said
 *                so in KNOWN_LIMITATIONS.md.
 *
 * The shape is deliberately tiny. This is not a mail client: it reads unseen
 * requests addressed to the agent and sends receipts back. Everything above the
 * port -- turning a sentence into a cart, deciding whether money may move --
 * happens elsewhere and is the same in both modes.
 */

export interface InboundEmail {
  /** The provider's message id (or a fixture one). Stable across pulls. */
  id: string;
  from: string;
  to: string;
  subject: string;
  /** Plain text body. HTML-only mail is reduced to text before it gets here. */
  text: string;
  received_at: string;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  /**
   * The same key always names the same email. A sender that retries after a
   * crash must not produce two receipts, so the port refuses to send a key it
   * has already sent and hands back the original instead.
   */
  idempotency_key: string;
  in_reply_to?: string;
}

export interface SentEmail {
  id: string;
  to: string;
  subject: string;
  idempotency_key: string;
  sent_at: string;
  /** True when this call did nothing because the key had already been sent. */
  deduplicated: boolean;
}

export interface MailPort {
  readonly mode: "fixture" | "live";
  /** Unseen mail addressed to the agent, oldest first. Marks it seen. */
  pull(): Promise<InboundEmail[]>;
  send(email: OutboundEmail): Promise<SentEmail>;
}

export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailError";
  }
}

/* ------------------------------------------------------------------ fixture */

export interface FixtureMailOptions {
  /** The agent's own address, so `to` on fixture mail looks like the real thing. */
  address?: string;
  now?: () => Date;
}

export class FixtureMail implements MailPort {
  readonly mode = "fixture" as const;
  readonly address: string;

  readonly #now: () => Date;
  #counter = 0;
  readonly #inbox: InboundEmail[] = [];
  readonly #sent: SentEmail[] = [];
  readonly #sentBodies = new Map<string, OutboundEmail>();
  readonly #byKey = new Map<string, SentEmail>();
  #failNext: { reason: string; times: number } | undefined;

  constructor(opts: FixtureMailOptions = {}) {
    this.address = opts.address ?? "agent@mercury.test";
    this.#now = opts.now ?? (() => new Date());
  }

  #id(prefix: string): string {
    this.#counter += 1;
    return `${prefix}_FIX${String(this.#counter).padStart(5, "0")}`;
  }

  /** The "send a test email" button. Lands in the inbox as unseen. */
  inject(email: { from: string; subject: string; text: string }): InboundEmail {
    const inbound: InboundEmail = {
      id: this.#id("msg"),
      from: email.from,
      to: this.address,
      subject: email.subject,
      text: email.text,
      received_at: this.#now().toISOString(),
    };
    this.#inbox.push(inbound);
    return inbound;
  }

  async pull(): Promise<InboundEmail[]> {
    return this.#inbox.splice(0, this.#inbox.length);
  }

  /** Make the next `send` fail -- the bounce a chaos row injects. */
  failNext(reason = "550 mailbox unavailable", times = 1): void {
    this.#failNext = { reason, times };
  }

  async send(email: OutboundEmail): Promise<SentEmail> {
    const prior = this.#byKey.get(email.idempotency_key);
    if (prior !== undefined) return { ...prior, deduplicated: true };

    if (this.#failNext !== undefined) {
      const { reason } = this.#failNext;
      this.#failNext.times -= 1;
      if (this.#failNext.times <= 0) this.#failNext = undefined;
      throw new MailError(reason);
    }

    const sent: SentEmail = {
      id: this.#id("sent"),
      to: email.to,
      subject: email.subject,
      idempotency_key: email.idempotency_key,
      sent_at: this.#now().toISOString(),
      deduplicated: false,
    };
    this.#sent.push(sent);
    this.#sentBodies.set(sent.id, email);
    this.#byKey.set(email.idempotency_key, sent);
    return sent;
  }

  /** Everything sent so far, oldest first, with bodies -- the fixture's "Sent" folder. */
  sent(): (SentEmail & { text: string })[] {
    return this.#sent.map((s) => ({ ...s, text: this.#sentBodies.get(s.id)?.text ?? "" }));
  }
}

/* -------------------------------------------------------------------- Gmail */

export interface GmailMailOptions {
  user: string;
  appPassword: string;
  imapHost?: string;
  smtpHost?: string;
  now?: () => Date;
  /** Injected in tests. Absent, the real imapflow / nodemailer are loaded lazily. */
  transports?: GmailTransports;
}

/** The two things Gmail is, reduced to the calls this port makes. */
export interface GmailTransports {
  imap(): Promise<ImapLike>;
  smtp(): Promise<SmtpLike>;
}

export interface ImapLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(query: { seen: boolean }, opts: { uid: boolean }): Promise<number[] | false | undefined>;
  fetchAll(
    range: number[] | string,
    query: { uid: boolean; envelope: boolean; source: boolean; internalDate: boolean },
    opts: { uid: boolean },
  ): Promise<
    {
      uid: number;
      envelope?: { messageId?: string; subject?: string; from?: { address?: string }[]; to?: { address?: string }[] };
      source?: Buffer;
      internalDate?: Date;
    }[]
  >;
  messageFlagsAdd(range: number[] | string, flags: string[], opts: { uid: boolean }): Promise<boolean>;
}

export interface SmtpLike {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}

export class GmailMail implements MailPort {
  readonly mode = "live" as const;

  readonly #user: string;
  readonly #appPassword: string;
  readonly #imapHost: string;
  readonly #smtpHost: string;
  readonly #now: () => Date;
  readonly #transports: GmailTransports;
  /**
   * Idempotency, remembered for the life of the process. The durable record is
   * the ledger's EMAIL_SENT entry, which the outbox consults before it ever
   * calls this; this map is the last line, not the first.
   */
  readonly #byKey = new Map<string, SentEmail>();

  constructor(opts: GmailMailOptions) {
    if (opts.user === "" || opts.appPassword === "") {
      throw new MailError("GmailMail needs GMAIL_USER and GMAIL_APP_PASSWORD");
    }
    this.#user = opts.user;
    this.#appPassword = opts.appPassword;
    this.#imapHost = opts.imapHost ?? "imap.gmail.com";
    this.#smtpHost = opts.smtpHost ?? "smtp.gmail.com";
    this.#now = opts.now ?? (() => new Date());
    this.#transports = opts.transports ?? this.#realTransports();
  }

  #realTransports(): GmailTransports {
    return {
      imap: async () => {
        const { ImapFlow } = await import("imapflow");
        return new ImapFlow({
          host: this.#imapHost,
          port: 993,
          secure: true,
          auth: { user: this.#user, pass: this.#appPassword },
          logger: false,
        }) as unknown as ImapLike;
      },
      smtp: async () => {
        const nodemailer = await import("nodemailer");
        return nodemailer.createTransport({
          host: this.#smtpHost,
          port: 465,
          secure: true,
          auth: { user: this.#user, pass: this.#appPassword },
        }) as unknown as SmtpLike;
      },
    };
  }

  async pull(): Promise<InboundEmail[]> {
    const client = await this.#transports.imap();
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (uids === false || uids === undefined || uids.length === 0) return [];

      const messages = await client.fetchAll(
        uids,
        { uid: true, envelope: true, source: true, internalDate: true },
        { uid: true },
      );

      const out: InboundEmail[] = [];
      for (const m of messages) {
        const text = m.source === undefined ? "" : await textOf(m.source);
        out.push({
          id: m.envelope?.messageId ?? `uid_${m.uid}`,
          from: m.envelope?.from?.[0]?.address ?? "",
          to: m.envelope?.to?.[0]?.address ?? this.#user,
          subject: m.envelope?.subject ?? "",
          text,
          received_at: (m.internalDate ?? this.#now()).toISOString(),
        });
      }
      // Seen only after we hold the text. A crash between fetch and flag
      // re-reads the mail next time, which the intake's idempotency absorbs;
      // the other order would lose a request for good.
      await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      out.sort((a, b) => a.received_at.localeCompare(b.received_at));
      return out;
    } finally {
      lock.release();
      await client.logout().catch(() => undefined);
    }
  }

  async send(email: OutboundEmail): Promise<SentEmail> {
    const prior = this.#byKey.get(email.idempotency_key);
    if (prior !== undefined) return { ...prior, deduplicated: true };

    const transporter = await this.#transports.smtp();
    const info = await transporter.sendMail({
      from: this.#user,
      to: email.to,
      subject: email.subject,
      text: email.text,
      ...(email.in_reply_to === undefined ? {} : { inReplyTo: email.in_reply_to, references: email.in_reply_to }),
      headers: { "X-Mercury-Idempotency-Key": email.idempotency_key },
    });

    const sent: SentEmail = {
      id: info.messageId ?? `sent_${createHash("sha256").update(email.idempotency_key).digest("hex").slice(0, 12)}`,
      to: email.to,
      subject: email.subject,
      idempotency_key: email.idempotency_key,
      sent_at: this.#now().toISOString(),
      deduplicated: false,
    };
    this.#byKey.set(email.idempotency_key, sent);
    return sent;
  }
}

/** Plain text out of a raw RFC 822 message; HTML-only mail is stripped to text. */
async function textOf(source: Buffer): Promise<string> {
  const { simpleParser } = await import("mailparser");
  const parsed = await simpleParser(source);
  if (typeof parsed.text === "string" && parsed.text.trim() !== "") return parsed.text.trim();
  if (typeof parsed.html === "string") {
    return parsed.html
      .replace(/<style[\s\S]*?<\/style>/giu, "")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }
  return "";
}
