import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MoneyError,
  applyBpsCeil,
  bpsBelow,
  bpsOf,
  discountBpsFloor,
  formatUSD,
  mulP,
  cents,
  dollars,
  splitByWeight,
  subP,
  sumP,
} from "./money.js";

describe("cents", () => {
  it("accepts non-negative integers", () => {
    expect(cents(0)).toBe(0);
    expect(cents(29900)).toBe(29900);
  });

  it("rejects floats -- the whole point of the branded type", () => {
    expect(() => cents(1.5)).toThrow(MoneyError);
    expect(() => cents(0.1 + 0.2)).toThrow(MoneyError);
  });

  it("rejects negatives, NaN and Infinity", () => {
    expect(() => cents(-1)).toThrow(MoneyError);
    expect(() => cents(Number.NaN)).toThrow(MoneyError);
    expect(() => cents(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe("dollars", () => {
  it("converts whole and two-decimal dollars", () => {
    expect(dollars(299)).toBe(29900);
    expect(dollars(0.5)).toBe(50);
    expect(dollars(1234.56)).toBe(123456);
  });

  it("rejects sub-cents precision", () => {
    expect(() => dollars(1.234)).toThrow(MoneyError);
  });
});

describe("arithmetic", () => {
  it("subP throws rather than going negative", () => {
    expect(() => subP(cents(100), cents(101))).toThrow(MoneyError);
  });

  it("mulP rejects fractional quantities", () => {
    expect(() => mulP(cents(100), 1.5)).toThrow(MoneyError);
  });

  it("sumP of an empty list is zero", () => {
    expect(sumP([])).toBe(0);
  });
});

describe("applyBpsCeil -- margin floors round UP, always favouring the merchant", () => {
  it("never returns less than the input", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 50_000 }), (amt, bps) => {
        const floor = applyBpsCeil(cents(amt), bps);
        return floor >= amt;
      }),
    );
  });

  it("rounds up, never down", () => {
    // 333 cents at 1 bp = 333.0333 -> 334
    expect(applyBpsCeil(cents(333), 1)).toBe(334);
    // exact multiples do not gain a spurious cent
    expect(applyBpsCeil(cents(10_000), 1_000)).toBe(11_000);
  });

  it("0 bps is identity", () => {
    expect(applyBpsCeil(cents(12345), 0)).toBe(12345);
  });
});

describe("discountBpsFloor -- discounts round DOWN, also favouring the merchant", () => {
  it("never exceeds the naive discount", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 10_000 }), (amt, bps) => {
        const d = discountBpsFloor(cents(amt), bps);
        return d <= (amt * bps) / 10_000 && d >= 0;
      }),
    );
  });
});

describe("bpsBelow", () => {
  it("measures how far a price sits under list", () => {
    expect(bpsBelow(cents(10_000), cents(9_000))).toBe(1_000); // 10% = 1000bps
    expect(bpsBelow(cents(10_000), cents(10_000))).toBe(0);
    expect(bpsBelow(cents(10_000), cents(11_000))).toBe(0); // above list is not a discount
  });

  it("never applies MORE discount than requested (merchant-favouring, always)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), fc.integer({ min: 0, max: 9_000 }), (list, bps) => {
        const discounted = cents(list - discountBpsFloor(cents(list), bps));
        return bpsBelow(cents(list), discounted) <= bps;
      }),
    );
  });

  it("is exact to within one bp once a 1-bp step is worth at least a cent", () => {
    // Below ~10000 cents a single basis point rounds away to nothing, so the
    // measured discount is legitimately 0. That is the floor doing its job.
    fc.assert(
      fc.property(fc.integer({ min: 10_000, max: 10_000_000 }), fc.integer({ min: 0, max: 9_000 }), (list, bps) => {
        const discounted = cents(list - discountBpsFloor(cents(list), bps));
        return Math.abs(bpsBelow(cents(list), discounted) - bps) <= 1;
      }),
    );
  });
});

describe("formatUSD", () => {
  it("renders cents as dollars with thousands grouping", () => {
    expect(formatUSD(cents(0))).toBe("$0.00");
    expect(formatUSD(cents(29900))).toBe("$299.00");
    expect(formatUSD(cents(5))).toBe("$0.05");
    expect(formatUSD(cents(10_000_000))).toBe("$100,000.00");
  });
});

/* ------------------------------------------------------- split settlement */

describe("splitByWeight", () => {
  it("divides in proportion to the weights", () => {
    expect(splitByWeight(cents(1_000), [1, 1])).toEqual([500, 500]);
    expect(splitByWeight(cents(900), [2, 1])).toEqual([600, 300]);
  });

  it("never loses or invents a cent", () => {
    // 100 / 3 is the classic case: 33.33 each, and one cent has to land
    // somewhere. Largest remainder puts it on the first share, deterministically.
    expect(splitByWeight(cents(100), [1, 1, 1])).toEqual([34, 33, 33]);
    expect(sumP(splitByWeight(cents(100), [1, 1, 1]))).toBe(100);
  });

  it("gives everything to the first share when no weight has any weight", () => {
    expect(splitByWeight(cents(500), [0, 0])).toEqual([500, 0]);
  });

  it("returns nothing for no shares", () => {
    expect(splitByWeight(cents(500), [])).toEqual([]);
  });

  it("rejects a negative weight", () => {
    expect(() => splitByWeight(cents(100), [1, -1])).toThrow(MoneyError);
  });

  it("PROPERTY: the split always sums to exactly the total", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 8 }),
        (total, weights) => {
          const parts = splitByWeight(cents(total), weights);
          expect(parts).toHaveLength(weights.length);
          expect(parts.every((p) => p >= 0)).toBe(true);
          expect(sumP(parts)).toBe(total);
        },
      ),
    );
  });
});

describe("bpsOf", () => {
  it("rounds the fee down, so the payer keeps the fraction", () => {
    expect(bpsOf(cents(10_001), 200)).toBe(200);
    expect(bpsOf(cents(100_000), 250)).toBe(2_500);
    expect(bpsOf(cents(999), 0)).toBe(0);
  });
});
