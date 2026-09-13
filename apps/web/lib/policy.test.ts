import { describe, expect, it } from "vitest";
import { type MerchantProfile, zPolicyPatch } from "@mercury/core";
import { applyPolicyPatch, policyDrift } from "./policy";

const QUICK: MerchantProfile = {
  merchant_id: "mch_quick",
  display_name: "Quick",
  vertical: "quick_commerce",
  min_margin_bps: 1_500,
  max_discount_bps: 2_000,
  levers: ["bundle", "substitute"],
  category_taxonomy: ["staples", "dairy"],
};

const B2B: MerchantProfile = {
  ...QUICK,
  merchant_id: "mch_b2b",
  vertical: "b2b_procurement",
  settlement: { mode: "route", commission_bps: 250, commission_account_id: "acc_platform" },
};

describe("applyPolicyPatch", () => {
  it("moves the margin floor and records the before and after", () => {
    const { next, changes } = applyPolicyPatch(QUICK, {
      merchant_id: "mch_quick",
      min_margin_bps: 2_000,
    });
    expect(next.min_margin_bps).toBe(2_000);
    expect(changes).toEqual([{ field: "min_margin_bps", from: 1_500, to: 2_000 }]);
  });

  it("reports nothing when the patch changes nothing", () => {
    const { changes } = applyPolicyPatch(QUICK, {
      merchant_id: "mch_quick",
      min_margin_bps: 1_500,
      levers: ["substitute", "bundle"], // same set, different order
    });
    expect(changes).toEqual([]);
  });

  it("never touches identity or the category allowlist", () => {
    const { next } = applyPolicyPatch(QUICK, {
      merchant_id: "mch_quick",
      min_margin_bps: 100,
    });
    expect(next.merchant_id).toBe("mch_quick");
    expect(next.vertical).toBe("quick_commerce");
    expect(next.display_name).toBe("Quick");
    expect(next.category_taxonomy).toEqual(["staples", "dairy"]);
  });

  it("edits the Route commission without moving the account it lands in", () => {
    const { next, changes } = applyPolicyPatch(B2B, {
      merchant_id: "mch_b2b",
      commission_bps: 400,
    });
    expect(next.settlement?.commission_bps).toBe(400);
    expect(next.settlement?.commission_account_id).toBe("acc_platform");
    expect(changes[0]?.field).toBe("settlement.commission_bps");
  });

  it("does not invent a settlement block for a merchant that has none", () => {
    const { next, changes } = applyPolicyPatch(QUICK, {
      merchant_id: "mch_quick",
      commission_bps: 400,
    });
    expect(next.settlement).toBeUndefined();
    expect(changes).toEqual([]);
  });
});

describe("zPolicyPatch", () => {
  it("rejects a discount ceiling above the whole price", () => {
    expect(zPolicyPatch.safeParse({ merchant_id: "m", max_discount_bps: 10_001 }).success).toBe(
      false,
    );
  });

  it("rejects a non-integer bps, because money is never fractional here", () => {
    expect(zPolicyPatch.safeParse({ merchant_id: "m", min_margin_bps: 15.5 }).success).toBe(false);
  });

  it("rejects an unknown lever", () => {
    expect(zPolicyPatch.safeParse({ merchant_id: "m", levers: ["freebies"] }).success).toBe(false);
  });

  it("strips fields a merchant may not set", () => {
    const parsed = zPolicyPatch.parse({
      merchant_id: "m",
      vertical: "b2b_procurement",
      category_taxonomy: ["anything"],
      commission_account_id: "acc_mine",
    });
    expect(parsed).toEqual({ merchant_id: "m" });
  });
});

describe("policyDrift", () => {
  it("is empty for an untouched profile", () => {
    expect(policyDrift(QUICK, QUICK)).toEqual([]);
  });

  it("names every field that has moved away from the seed", () => {
    const edited: MerchantProfile = { ...QUICK, min_margin_bps: 2_000, levers: ["bundle"] };
    expect(policyDrift(edited, QUICK).sort()).toEqual(["levers", "min_margin_bps"]);
  });
});
