import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH } from "@mercury/core";
import { Ledger } from "./ledger.js";

function freshLedger(): Ledger {
  return Ledger.open(":memory:");
}

function seedThree(s: Ledger): void {
  s.append({
    actor: { type: "human", id: "prn_alice" },
    event_type: "MANDATE_ISSUED",
    delegation_scope: { mandate_id: "mnd_1", scope_hash: "a".repeat(64) },
    envelope: { reserved_cents: 200_000, consumed_cents: 0, remaining_cents: 200_000 },
  });
  s.append({
    actor: { type: "merchant_agent", id: "agt_revenue" },
    event_type: "OFFER_PROPOSED",
    detail: { lines: 2, quoted_total_cents: 84_000 },
  });
  s.append({
    actor: { type: "gate", id: "gate" },
    event_type: "GATE_DECISION",
    decision: {
      outcome: "ALLOW",
      rule_ids: ["MARGIN.FLOOR_BREACH", "MANDATE.PER_TXN_CAP"],
      evidence: [
        {
          rule_id: "MARGIN.FLOOR_BREACH",
          passed: true,
          observed: 87_500,
          limit: 87_500,
          message: "unit price at floor",
        },
      ],
    },
  });
}

describe("Ledger append", () => {
  it("starts from the genesis hash and assigns sequential seq", () => {
    const s = freshLedger();
    expect(s.tipHash()).toBe(GENESIS_HASH);

    const e1 = s.append({ actor: { type: "system", id: "boot" }, event_type: "CIRCUIT_UNFROZEN" });
    expect(e1.seq).toBe(1);
    expect(e1.prev_hash).toBe(GENESIS_HASH);

    const e2 = s.append({ actor: { type: "system", id: "boot" }, event_type: "CIRCUIT_FROZEN" });
    expect(e2.seq).toBe(2);
    expect(e2.prev_hash).toBe(e1.hash);
    s.close();
  });

  it("links every entry to the previous one", () => {
    const s = freshLedger();
    seedThree(s);
    const rows = s.read();
    expect(rows).toHaveLength(3);
    expect(rows[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.hash);
    s.close();
  });

  it("round-trips structured decision records", () => {
    const s = freshLedger();
    seedThree(s);
    const decision = s.byEventType("GATE_DECISION")[0];
    expect(decision?.decision?.outcome).toBe("ALLOW");
    expect(decision?.decision?.evidence[0]?.observed).toBe(87_500);
    s.close();
  });
});

describe("Ledger verify -- the auditability proof", () => {
  it("verifies a clean chain", () => {
    const s = freshLedger();
    seedThree(s);
    expect(s.verify()).toEqual({ ok: true, count: 3 });
    s.close();
  });

  it("verifies an empty chain", () => {
    const s = freshLedger();
    expect(s.verify()).toEqual({ ok: true, count: 0 });
    s.close();
  });

  it("catches an edited body at the exact seq", () => {
    const s = freshLedger();
    seedThree(s);

    // A judge opening the DB and changing a number, by hand.
    s.db.prepare("UPDATE ledger SET body = REPLACE(body, '84000', '8400') WHERE seq = 2").run();

    const r = s.verify();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.broken_at).toBe(2);
    expect(r.reason).toBe("HASH_MISMATCH");
    s.close();
  });

  it("catches tampering with an indexed column even though the hash covers only the body", () => {
    const s = freshLedger();
    seedThree(s);
    s.db.prepare("UPDATE ledger SET event_type = 'ORDER_CREATED' WHERE seq = 2").run();

    const r = s.verify();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.broken_at).toBe(2);
    expect(r.reason).toBe("COLUMN_TAMPERED");
    s.close();
  });

  it("catches a deleted entry as a sequence gap", () => {
    const s = freshLedger();
    seedThree(s);
    s.db.prepare("DELETE FROM ledger WHERE seq = 2").run();

    const r = s.verify();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.broken_at).toBe(3);
    expect(r.reason).toBe("SEQ_GAP");
    s.close();
  });

  it("catches a re-hashed entry via the broken forward link", () => {
    // The sophisticated tamper: edit the body AND recompute that row's hash.
    // The next row's prev_hash no longer matches, so the chain still fails.
    const s = freshLedger();
    seedThree(s);

    const row = s.db.prepare("SELECT body, prev_hash FROM ledger WHERE seq = 2").get() as {
      body: string;
      prev_hash: string;
    };
    const forged = row.body.replace("84000", "8400");
    const forgedHash = createHash("sha256").update(row.prev_hash + forged, "utf8").digest("hex");
    s.db.prepare("UPDATE ledger SET body = ?, hash = ? WHERE seq = 2").run(forged, forgedHash);

    const r = s.verify();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.broken_at).toBe(3);
    expect(r.reason).toBe("PREV_HASH_MISMATCH");
    s.close();
  });
});

describe("the merchant-console events", () => {
  it("chains BASKET_VALUED and finds it by type", () => {
    const s = freshLedger();
    seedThree(s);
    s.append({
      actor: { type: "merchant_agent", id: "agt_revenue" },
      event_type: "BASKET_VALUED",
      detail: {
        merchant_id: "mch_quick",
        baseline_cents: 482_000,
        final_cents: 561_000,
        uplift_cents: 79_000,
        uplift_bps: 1_639,
        levers_used: ["bundle"],
      },
    });

    const found = s.byEventType("BASKET_VALUED");
    expect(found.length).toBe(1);
    expect(found[0]?.detail?.["uplift_cents"]).toBe(79_000);
    expect(s.verify().ok).toBe(true);
  });

  it("records a policy change as a fact in the chain, not a side note", () => {
    const s = freshLedger();
    s.append({
      actor: { type: "human", id: "mch_quick" },
      event_type: "POLICY_CHANGED",
      detail: {
        merchant_id: "mch_quick",
        changes: [{ field: "min_margin_bps", from: 1_500, to: 2_000 }],
      },
    });

    const [entry] = s.byEventType("POLICY_CHANGED");
    expect(entry?.actor.type).toBe("human");
    expect(s.verify().ok).toBe(true);
  });

  it("keeps verifying once the new types are interleaved with the old", () => {
    const s = freshLedger();
    seedThree(s);
    s.append({
      actor: { type: "human", id: "mch_quick" },
      event_type: "POLICY_CHANGED",
      detail: { merchant_id: "mch_quick", changes: [] },
    });
    seedThree(s);
    s.append({
      actor: { type: "merchant_agent", id: "agt_revenue" },
      event_type: "BASKET_VALUED",
      detail: { merchant_id: "mch_quick", uplift_cents: 1 },
    });

    expect(s.count()).toBe(8);
    expect(s.verify().ok).toBe(true);
  });
});
