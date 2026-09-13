import { createSign } from "node:crypto";

/**
 * Google service-account authentication, shared by the Calendar and Sheets
 * ports.
 *
 * A service account authenticates by signing a JWT with its own key and
 * exchanging it for a short-lived access token. Two HTTP calls and twelve
 * lines of `node:crypto`; the alternative is a dependency that does a hundred
 * other things.
 */

/** The fields of a service-account JSON these ports read. */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export class GoogleAuth {
  readonly #sa: ServiceAccount;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #tokens = new Map<string, { value: string; expires_at: number }>();

  constructor(sa: ServiceAccount, opts: { fetchImpl?: typeof fetch; now?: () => Date } = {}) {
    if (sa.client_email === "" || sa.private_key === "") {
      throw new GoogleAuthError("a service account needs client_email and private_key");
    }
    this.#sa = sa;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now ?? (() => new Date());
  }

  /** A bearer token for `scope`, cached until a minute before it expires. */
  async accessToken(scope: string): Promise<string> {
    const nowSec = Math.floor(this.#now().getTime() / 1000);
    const cached = this.#tokens.get(scope);
    if (cached !== undefined && cached.expires_at - 60 > nowSec) return cached.value;

    const assertion = serviceAccountJwt(this.#sa, scope, nowSec);
    const res = await this.#fetch(this.#sa.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
    });
    if (!res.ok) {
      throw new GoogleAuthError(`google token: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.#tokens.set(scope, { value: body.access_token, expires_at: nowSec + body.expires_in });
    return body.access_token;
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

/** RS256 over `header.claims`, the way Google's OAuth 2.0 server-to-server flow specifies. */
export function serviceAccountJwt(sa: ServiceAccount, scope: string, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: sa.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).end().sign(sa.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}
