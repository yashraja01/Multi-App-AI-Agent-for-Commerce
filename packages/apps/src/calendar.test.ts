import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CalendarError, FixtureCalendar, GoogleCalendar } from "./calendar.js";
import { serviceAccountJwt } from "./google.js";

const NOW = new Date("2026-09-14T09:00:00.000Z");
const delivery = {
  title: "Delivery — Harbor Wholesale Supply",
  description: "10 x Whole Bean Coffee 5lb\n6 x Oat Milk (12 x 1L case)",
  start: "2026-09-16T09:00:00.000Z",
  end: "2026-09-16T11:00:00.000Z",
  order_id: "pi_FIX0000001",
  idempotency_key: "delivery:ses_1",
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const sa = {
  client_email: "mercury@project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
};

describe("FixtureCalendar", () => {
  it("creates once per idempotency key", async () => {
    const cal = new FixtureCalendar();
    const a = await cal.create(delivery);
    const b = await cal.create(delivery);
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(cal.events()).toHaveLength(1);
    expect(cal.events()[0]?.input.order_id).toBe("pi_FIX0000001");
  });

  it("fails on demand, once, without recording the event", async () => {
    const cal = new FixtureCalendar();
    cal.failNext();
    await expect(cal.create(delivery)).rejects.toThrow(CalendarError);
    expect(cal.events()).toHaveLength(0);
    expect((await cal.create(delivery)).deduplicated).toBe(false);
  });
});

describe("service-account JWT", () => {
  it("is RS256 over header.claims and verifies with the public key", () => {
    const jwt = serviceAccountJwt(sa, "https://www.googleapis.com/auth/calendar.events", 1_780_000_000);
    const [h, c, s] = jwt.split(".");
    if (h === undefined || c === undefined || s === undefined) throw new Error("not a JWT");
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg: string };
    const claims = JSON.parse(Buffer.from(c, "base64url").toString()) as { iss: string; exp: number; iat: number; aud: string };
    expect(header.alg).toBe("RS256");
    expect(claims.iss).toBe(sa.client_email);
    expect(claims.exp - claims.iat).toBe(3600);
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).end().verify(publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("GoogleCalendar", () => {
  it("refuses to start without a service account or calendar id", () => {
    expect(() => new GoogleCalendar({ serviceAccount: { client_email: "", private_key: "" }, calendarId: "c" })).toThrow(CalendarError);
    expect(() => new GoogleCalendar({ serviceAccount: sa, calendarId: "" })).toThrow(CalendarError);
  });

  it("exchanges a JWT for a token once, then inserts the event with the order id attached", async () => {
    const calls: { url: string; body: string; auth: string | undefined }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), body: String(init?.body ?? ""), auth: headers["Authorization"] });
      if (String(url).endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "evt_g1", htmlLink: "https://calendar.google.com/event?eid=evt_g1" }), { status: 200 });
    };
    const cal = new GoogleCalendar({ serviceAccount: sa, calendarId: "deliveries@group.calendar.google.com", fetchImpl, now: () => NOW });

    const a = await cal.create(delivery);
    const b = await cal.create({ ...delivery, idempotency_key: "delivery:ses_2" });

    expect(a.id).toBe("evt_g1");
    expect(a.html_link).toContain("calendar.google.com");
    expect(b.deduplicated).toBe(false);
    // One token exchange for two inserts.
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    const inserts = calls.filter((c) => c.url.includes("/events"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.url).toContain(encodeURIComponent("deliveries@group.calendar.google.com"));
    expect(inserts[0]?.auth).toBe("Bearer ya29.test");
    const payload = JSON.parse(inserts[0]?.body ?? "{}") as { summary: string; extendedProperties: { private: Record<string, string> } };
    expect(payload.summary).toBe(delivery.title);
    expect(payload.extendedProperties.private["mercury_order_id"]).toBe("pi_FIX0000001");
  });

  it("surfaces an API failure as a CalendarError", async () => {
    const fetchImpl: typeof fetch = async (url) =>
      String(url).endsWith("/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 })
        : new Response("backend error", { status: 500 });
    const cal = new GoogleCalendar({ serviceAccount: sa, calendarId: "c", fetchImpl });
    await expect(cal.create(delivery)).rejects.toThrow(/500/);
  });
});
