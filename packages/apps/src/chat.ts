/**
 * Chat -- how the agent asks the team for permission, and tells them what it did.
 *
 * One port, two implementations, chosen by `CHAT_MODE`:
 *
 *   FixtureChat  an in-memory channel. `posted()` is what a test reads.
 *   SlackChat    one Slack incoming webhook. A URL is the whole credential.
 *
 * Two kinds of message, and only two. An *approval request*, when the gate
 * says a human must release the money; and a *summary*, after a run ends. The
 * agent never uses chat to negotiate, never reads from it, and never treats a
 * reply as authority -- approval happens on the link, against the gate.
 */

export type ChatKind = "approval_request" | "summary";

export interface ChatMessage {
  kind: ChatKind;
  /** One line. What a phone notification shows. */
  text: string;
  /** The rest, as short labelled facts. Rendered as fields in Slack. */
  fields?: { label: string; value: string }[];
  /** A link the reader may open: the approval page, or the audit trail. */
  link?: { label: string; url: string };
  /**
   * Same rule as mail: the same key always names the same message, and a
   * retry after a crash posts nothing twice.
   */
  idempotency_key: string;
}

export interface PostedMessage {
  id: string;
  kind: ChatKind;
  text: string;
  idempotency_key: string;
  posted_at: string;
  deduplicated: boolean;
}

export interface ChatPort {
  readonly mode: "fixture" | "live";
  post(message: ChatMessage): Promise<PostedMessage>;
}

export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatError";
  }
}

/* ------------------------------------------------------------------ fixture */

export class FixtureChat implements ChatPort {
  readonly mode = "fixture" as const;
  readonly channel: string;

  readonly #now: () => Date;
  #counter = 0;
  readonly #posted: (PostedMessage & { message: ChatMessage })[] = [];
  readonly #byKey = new Map<string, PostedMessage>();
  #failNext: { reason: string; times: number } | undefined;

  constructor(opts: { channel?: string; now?: () => Date } = {}) {
    this.channel = opts.channel ?? "#purchasing";
    this.#now = opts.now ?? (() => new Date());
  }

  /** Make the next `post` fail -- "Slack is down", for a chaos row. */
  failNext(reason = "slack: 503 service unavailable", times = 1): void {
    this.#failNext = { reason, times };
  }

  async post(message: ChatMessage): Promise<PostedMessage> {
    const prior = this.#byKey.get(message.idempotency_key);
    if (prior !== undefined) return { ...prior, deduplicated: true };

    if (this.#failNext !== undefined) {
      const { reason } = this.#failNext;
      this.#failNext.times -= 1;
      if (this.#failNext.times <= 0) this.#failNext = undefined;
      throw new ChatError(reason);
    }

    this.#counter += 1;
    const posted: PostedMessage = {
      id: `slack_FIX${String(this.#counter).padStart(5, "0")}`,
      kind: message.kind,
      text: message.text,
      idempotency_key: message.idempotency_key,
      posted_at: this.#now().toISOString(),
      deduplicated: false,
    };
    this.#posted.push({ ...posted, message });
    this.#byKey.set(message.idempotency_key, posted);
    return posted;
  }

  /** The channel, oldest first. */
  posted(): readonly (PostedMessage & { message: ChatMessage })[] {
    return this.#posted;
  }
}

/* -------------------------------------------------------------------- Slack */

export interface SlackChatOptions {
  webhookUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class SlackChat implements ChatPort {
  readonly mode = "live" as const;

  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #byKey = new Map<string, PostedMessage>();

  constructor(opts: SlackChatOptions) {
    if (!opts.webhookUrl.startsWith("https://hooks.slack.com/")) {
      throw new ChatError("SlackChat needs a Slack incoming-webhook URL (https://hooks.slack.com/...)");
    }
    this.#url = opts.webhookUrl;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now ?? (() => new Date());
  }

  async post(message: ChatMessage): Promise<PostedMessage> {
    const prior = this.#byKey.get(message.idempotency_key);
    if (prior !== undefined) return { ...prior, deduplicated: true };

    const res = await this.#fetch(this.#url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload(message)),
    });
    if (!res.ok) {
      throw new ChatError(`slack: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    const posted: PostedMessage = {
      id: `slack_${this.#now().getTime().toString(36)}`,
      kind: message.kind,
      text: message.text,
      idempotency_key: message.idempotency_key,
      posted_at: this.#now().toISOString(),
      deduplicated: false,
    };
    this.#byKey.set(message.idempotency_key, posted);
    return posted;
  }
}

/**
 * Block Kit, minimal. `text` is what notifications and old clients show; the
 * blocks are the same content laid out. Nothing here is interactive: Slack
 * buttons need a public callback URL, and the approval link is the approval.
 */
export function slackPayload(m: ChatMessage): {
  text: string;
  blocks: Record<string, unknown>[];
} {
  const blocks: Record<string, unknown>[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${m.text}*` } },
  ];
  if (m.fields !== undefined && m.fields.length > 0) {
    blocks.push({
      type: "section",
      fields: m.fields.slice(0, 10).map((f) => ({ type: "mrkdwn", text: `*${f.label}*\n${f.value}` })),
    });
  }
  if (m.link !== undefined) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `<${m.link.url}|${m.link.label}>` },
    });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `Mercury · ${m.kind.replace("_", " ")} · \`${m.idempotency_key}\`` }],
  });
  return { text: m.text, blocks };
}
