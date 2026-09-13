import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FixtureSheet, GoogleSheet, SheetError, cellsOf } from "./sheet.js";

const NOW = new Date("2026-09-14T09:00:00.000Z");
const row = {
  date: "2026-09-14",
  order_id: "pi_FIX0000001",
  supplier: "Harbor Wholesale Supply",
  items: "10 x Whole Bean Coffee 5lb, 6 x Oat Milk (12 x 1L case)",
  amount_cents: 53_404,
  requested_by: "manager@harborstreetcafe.test",
  audit_url: "http://localhost:3000/api/agent/audit?session_id=ses_1",
  idempotency_key: "log:ses_1",
};

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const sa = {
  client_email: "mercury@project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
};

describe("FixtureSheet", () => {
  it("appends once per idempotency key, below the header", async () => {
    const sheet = new FixtureSheet();
    const a = await sheet.append(row);
    const b = await sheet.append(row);
    expect(a.range).toBe("Purchases!A2:G2");
    expect(b.deduplicated).toBe(true);
    expect(sheet.rows()).toHaveLength(1);
    expect(sheet.rows()[0]?.row.amount_cents).toBe(53_404);
  });

  it("fails on demand, once, without recording the row", async () => {
    const sheet = new FixtureSheet();
    sheet.failNext();
    await expect(sheet.append(row)).rejects.toThrow(SheetError);
    expect(sheet.rows()).toHaveLength(0);
    expect((await sheet.append(row)).deduplicated).toBe(false);
  });

  it("writes the amount in dollars, never cents", () => {
    expect(cellsOf(row)[4]).toBe("534.04");
    expect(cellsOf(row)).toHaveLength(7);
  });
});

describe("GoogleSheet", () => {
  it("refuses to start without a service account or sheet id", () => {
    expect(() => new GoogleSheet({ serviceAccount: { client_email: "", private_key: "" }, sheetId: "s" })).toThrow(SheetError);
    expect(() => new GoogleSheet({ serviceAccount: sa, sheetId: "" })).toThrow(SheetError);
  });

  it("appends one row to the tab with USER_ENTERED values and reports where it landed", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url).endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ updates: { updatedRange: "Purchases!A12:G12" } }), { status: 200 });
    };
    const sheet = new GoogleSheet({ serviceAccount: sa, sheetId: "1AbC", fetchImpl, now: () => NOW });
    const a = await sheet.append(row);
    expect(a.range).toBe("Purchases!A12:G12");
    const append = calls.find((c) => c.url.includes(":append"));
    expect(append?.url).toContain("/spreadsheets/1AbC/values/");
    expect(append?.url).toContain("valueInputOption=USER_ENTERED");
    const payload = JSON.parse(append?.body ?? "{}") as { values: string[][] };
    expect(payload.values[0]?.[1]).toBe("pi_FIX0000001");
    expect(payload.values[0]?.[4]).toBe("534.04");
  });

  it("surfaces an API failure as a SheetError", async () => {
    const fetchImpl: typeof fetch = async (url) =>
      String(url).endsWith("/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 })
        : new Response("quota", { status: 429 });
    const sheet = new GoogleSheet({ serviceAccount: sa, sheetId: "s", fetchImpl });
    await expect(sheet.append(row)).rejects.toThrow(/429/);
  });
});
