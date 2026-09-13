import { describe, expect, it } from "vitest";
import { type CatalogItem, cents } from "@mercury/core";
import { Store } from "./store.js";

function item(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    sku: "SKU_LAST_ONE",
    merchant_id: "mch_demo",
    title: "The Last Unit",
    category: "staples",
    unit: "each",
    list_cents: cents(10_000),
    cost_cents: cents(6_000),
    stock: 1,
    moq: 1,
    ...over,
  };
}

function store(): Store {
  return Store.open(":memory:");
}

describe("F3: inventory race", () => {
  it("lets exactly one buyer take the last unit", () => {
    const s = store();
    s.putItem(item());

    const a = s.reserveStock("SKU_LAST_ONE", 1);
    const b = s.reserveStock("SKU_LAST_ONE", 1);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error("unreachable");
    expect(b.reason).toBe("INSUFFICIENT");
    expect(b.available).toBe(0);
    s.close();
  });

  it("never lets stock go negative under repeated contention", () => {
    const s = store();
    s.putItem(item({ stock: 10 }));

    let granted = 0;
    for (let i = 0; i < 50; i++) {
      if (s.reserveStock("SKU_LAST_ONE", 1).ok) granted += 1;
    }

    expect(granted).toBe(10);
    expect(s.getItem("SKU_LAST_ONE")?.stock).toBe(0);
    s.close();
  });

  it("rejects an over-large reservation without partially applying it", () => {
    const s = store();
    s.putItem(item({ stock: 3 }));
    const r = s.reserveStock("SKU_LAST_ONE", 5);
    expect(r.ok).toBe(false);
    expect(s.getItem("SKU_LAST_ONE")?.stock).toBe(3); // untouched
    s.close();
  });

  it("reports an unknown SKU distinctly from an out-of-stock one", () => {
    const s = store();
    const r = s.reserveStock("SKU_NOPE", 1);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("UNKNOWN_SKU");
    s.close();
  });

  it("releases stock back on an auto-refund", () => {
    const s = store();
    s.putItem(item({ stock: 1 }));
    s.reserveStock("SKU_LAST_ONE", 1);
    expect(s.getItem("SKU_LAST_ONE")?.stock).toBe(0);
    s.releaseStock("SKU_LAST_ONE", 1);
    expect(s.getItem("SKU_LAST_ONE")?.stock).toBe(1);
    s.close();
  });
});

describe("F7: intent token replay", () => {
  const token = {
    token_id: "itk_1",
    mandate_id: "mnd_1",
    cart_hash: "a".repeat(64),
    amount_cents: cents(55_000),
    nonce: "n1",
    issued_at: "2026-06-01T10:00:00.000Z",
    expires_at: "2026-06-01T10:05:00.000Z",
  };

  it("spends a token exactly once", () => {
    const s = store();
    s.issueToken(token);

    expect(s.spendToken("itk_1").ok).toBe(true);
    const second = s.spendToken("itk_1");
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.reason).toBe("ALREADY_SPENT");
    s.close();
  });

  it("rejects a token that was never issued", () => {
    const s = store();
    const r = s.spendToken("itk_ghost");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("UNKNOWN");
    s.close();
  });

  it("reports spent ids so Gate can deny a replay before any rail call", () => {
    const s = store();
    s.issueToken(token);
    expect(s.spentTokenIds().has("itk_1")).toBe(false);
    s.spendToken("itk_1");
    expect(s.spentTokenIds().has("itk_1")).toBe(true);
    s.close();
  });
});

describe("envelope drawdown -- the budget hold model", () => {
  const signed = {
    mandate: {
      mandate_id: "mnd_1",
      principal_id: "prn_alice",
      agent_id: "agt_1",
      agent_public_key: "agent-key-placeholder",
      vertical: "quick_commerce" as const,
      reserved_cents: cents(200_000),
      max_per_txn_cents: cents(100_000),
      max_txn_count: 5,
      requires_human_approval_above_cents: cents(150_000),
      scope: { merchant_allowlist: ["mch_demo"], category_allowlist: ["staples"] },
      human_present: false,
      not_before: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-12-31T00:00:00.000Z",
      nonce: "n",
    },
    signature: "sig",
    public_key: "pk",
  };

  it("draws down and counts debits", () => {
    const s = store();
    s.putMandate(signed);
    expect(s.getMandateState("mnd_1")).toEqual({
      consumed_cents: 0,
      txn_count: 0,
      status: "active",
    });

    const after = s.consumeEnvelope("mnd_1", cents(55_000));
    expect(after.consumed_cents).toBe(55_000);
    expect(after.txn_count).toBe(1);
    s.close();
  });

  it("restores budget on refund rather than silently burning it", () => {
    const s = store();
    s.putMandate(signed);
    s.consumeEnvelope("mnd_1", cents(55_000));
    s.restoreEnvelope("mnd_1", cents(55_000));
    expect(s.getMandateState("mnd_1")).toEqual({
      consumed_cents: 0,
      txn_count: 0,
      status: "active",
    });
    s.close();
  });

  it("releases the residual when the envelope is closed", () => {
    const s = store();
    s.putMandate(signed);
    s.consumeEnvelope("mnd_1", cents(60_000));
    const { released_cents } = s.closeEnvelope("mnd_1");
    expect(released_cents).toBe(140_000);
    expect(s.getMandateState("mnd_1")?.status).toBe("closed");
    s.close();
  });

  it("re-registering a mandate preserves its drawdown", () => {
    const s = store();
    s.putMandate(signed);
    s.consumeEnvelope("mnd_1", cents(60_000));
    s.putMandate(signed); // e.g. reseeding
    expect(s.getMandateState("mnd_1")?.consumed_cents).toBe(60_000);
    s.close();
  });
});

describe("freeze switch and webhook dedupe", () => {
  it("defaults to not frozen and toggles", () => {
    const s = store();
    expect(s.isFrozen()).toBe(false);
    s.setFrozen(true);
    expect(s.isFrozen()).toBe(true);
    s.setFrozen(false);
    expect(s.isFrozen()).toBe(false);
    s.close();
  });

  it("remembers seen webhook event ids idempotently", () => {
    const s = store();
    expect(s.hasSeenEvent("evt_1")).toBe(false);
    s.markEventSeen("evt_1");
    s.markEventSeen("evt_1");
    expect(s.hasSeenEvent("evt_1")).toBe(true);
    s.close();
  });
});

describe("catalog", () => {
  it("returns a sku-keyed map for a merchant, ready for Gate", () => {
    const s = store();
    s.putItem(item({ sku: "A" }));
    s.putItem(item({ sku: "B" }));
    s.putItem(item({ sku: "C", merchant_id: "mch_other" }));

    const cat = s.catalogFor("mch_demo");
    expect([...cat.keys()].sort()).toEqual(["A", "B"]);
    s.close();
  });

  it("reflects live stock, not the stock frozen into the item JSON", () => {
    const s = store();
    s.putItem(item({ stock: 5 }));
    s.reserveStock("SKU_LAST_ONE", 2);
    expect(s.catalogFor("mch_demo").get("SKU_LAST_ONE")?.stock).toBe(3);
    s.close();
  });
});

describe("order history", () => {
  function order(s: Store, id: string, merchantId: string | undefined, amount: number): void {
    s.putOrder({
      order_id: id,
      mandate_id: "mnd_x",
      token_id: `tok_${id}`,
      cart_hash: "h",
      amount: cents(amount),
      status: "created",
      ...(merchantId === undefined ? {} : { merchant_id: merchantId }),
    });
  }

  it("lists newest first", () => {
    const s = store();
    order(s, "ord_1", "mch_demo", 100);
    order(s, "ord_2", "mch_demo", 200);
    order(s, "ord_3", "mch_demo", 300);

    expect(s.listOrders().map((o) => o.order_id)).toEqual(["ord_3", "ord_2", "ord_1"]);
    s.close();
  });

  it("scopes to one merchant, because a merchant may not see another's orders", () => {
    const s = store();
    order(s, "ord_1", "mch_demo", 100);
    order(s, "ord_2", "mch_other", 200);

    expect(s.listOrders({ merchantId: "mch_demo" }).map((o) => o.order_id)).toEqual(["ord_1"]);
    expect(s.listOrders().length).toBe(2);
    s.close();
  });

  it("honours the limit", () => {
    const s = store();
    for (let i = 0; i < 5; i++) order(s, `ord_${i}`, "mch_demo", 100);
    expect(s.listOrders({ limit: 2 }).length).toBe(2);
    s.close();
  });

  it("stamps created_at when the caller does not", () => {
    const s = store();
    order(s, "ord_1", "mch_demo", 100);
    const row = s.getOrder("ord_1");
    expect(row?.created_at).toBeTypeOf("string");
    expect(Number.isNaN(Date.parse(row?.created_at ?? ""))).toBe(false);
    s.close();
  });

  it("leaves an unattributed order out of every merchant-scoped list", () => {
    const s = store();
    order(s, "ord_legacy", undefined, 100);

    expect(s.getOrder("ord_legacy")?.merchant_id).toBeNull();
    expect(s.listOrders({ merchantId: "mch_demo" })).toEqual([]);
    expect(s.listOrders().map((o) => o.order_id)).toEqual(["ord_legacy"]);
    s.close();
  });
});

describe("outbox -- what the engine owes the world", () => {
  const debt = { idempotency_key: "receipt:ses_1", run_id: "ses_1", app: "gmail", action: "send_receipt", payload: { to: "m@cafe" } };

  it("owes a key once", () => {
    const s = store();
    expect(s.enqueueOutbox({ ...debt, at: "2026-09-14T09:00:00.000Z" })).toBe(true);
    expect(s.enqueueOutbox({ ...debt, at: "2026-09-14T09:00:01.000Z" })).toBe(false);
    expect(s.listOutbox({ run_id: "ses_1" })).toHaveLength(1);
    expect(s.getOutbox("receipt:ses_1")?.payload).toEqual({ to: "m@cafe" });
    s.close();
  });

  it("is due immediately, then only after its next attempt time", () => {
    const s = store();
    s.enqueueOutbox({ ...debt, at: "2026-09-14T09:00:00.000Z" });
    expect(s.dueOutbox("2026-09-14T09:00:00.000Z").map((r) => r.idempotency_key)).toEqual(["receipt:ses_1"]);

    const after = s.failOutbox("receipt:ses_1", "550 bounce", "2026-09-14T09:00:05.000Z", "2026-09-14T09:00:00.500Z");
    expect(after?.status).toBe("pending");
    expect(after?.attempts).toBe(1);
    expect(after?.last_error).toBe("550 bounce");
    expect(s.dueOutbox("2026-09-14T09:00:01.000Z")).toHaveLength(0);
    expect(s.dueOutbox("2026-09-14T09:00:05.000Z")).toHaveLength(1);
    s.close();
  });

  it("completes with a result and leaves the due list", () => {
    const s = store();
    s.enqueueOutbox(debt);
    s.completeOutbox("receipt:ses_1", { id: "sent_1" });
    const row = s.getOutbox("receipt:ses_1");
    expect(row?.status).toBe("done");
    expect(row?.result).toEqual({ id: "sent_1" });
    expect(row?.attempts).toBe(1);
    expect(s.dueOutbox()).toHaveLength(0);
    s.close();
  });

  it("fails for good when no next attempt is scheduled", () => {
    const s = store();
    s.enqueueOutbox(debt);
    const row = s.failOutbox("receipt:ses_1", "gave up", undefined);
    expect(row?.status).toBe("failed");
    expect(s.dueOutbox()).toHaveLength(0);
    s.close();
  });
});
