import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { CanonicalError, GENESIS_HASH, canonicalJson, hashValue, sha256Hex } from "./canonical.js";
import { generateKeyPair, signValue, verifyValue } from "./signing.js";

describe("canonicalJson", () => {
  it("is independent of key insertion order", () => {
    const a = { b: 1, a: 2, c: { z: 3, y: 4 } };
    const b = { c: { y: 4, z: 3 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":2,"b":1,"c":{"y":4,"z":3}}');
  });

  it("omits undefined properties but rejects undefined array elements", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson([1, undefined, 3])).toThrow(CanonicalError);
  });

  it("normalises -0 so one value cannot produce two hashes", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(hashValue({ x: -0 })).toBe(hashValue({ x: 0 }));
  });

  it("rejects values with no canonical form", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalError);
    expect(() => canonicalJson(new Date())).toThrow(CanonicalError);
    expect(() => canonicalJson(10n)).toThrow(CanonicalError);
    expect(() => canonicalJson(Symbol("s"))).toThrow(CanonicalError);
    expect(() => canonicalJson(undefined)).toThrow(CanonicalError);
  });

  it("preserves array order (arrays are sequences, not sets)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("escapes strings via JSON.stringify semantics", () => {
    expect(canonicalJson({ 'k"e"y': 'v"al' })).toBe('{"k\\"e\\"y":"v\\"al"}');
    expect(canonicalJson("é\n\t")).toBe(JSON.stringify("é\n\t"));
  });

  it("is deterministic across shuffled key orders (property)", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean())),
        (obj) => {
          const shuffled = Object.fromEntries(Object.entries(obj).reverse());
          return canonicalJson(obj) === canonicalJson(shuffled);
        },
      ),
    );
  });

  it("round-trips through JSON.parse to an equal canonical form", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean())),
        (obj) => canonicalJson(JSON.parse(canonicalJson(obj))) === canonicalJson(obj),
      ),
    );
  });
});

describe("sha256Hex", () => {
  it("matches the known vector for the empty string", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("GENESIS_HASH is 64 zeros", () => {
    expect(GENESIS_HASH).toHaveLength(64);
    expect(GENESIS_HASH).toMatch(/^0{64}$/);
  });
});

describe("Ed25519 signing", () => {
  it("round-trips sign then verify", () => {
    const kp = generateKeyPair();
    const value = { mandate_id: "mnd_1", reserved_cents: 500_000 };
    const sig = signValue(value, kp.privateKey);
    expect(verifyValue(value, sig, kp.publicKey)).toBe(true);
  });

  it("verifies regardless of key order, because it signs canonical JSON", () => {
    const kp = generateKeyPair();
    const sig = signValue({ a: 1, b: 2 }, kp.privateKey);
    expect(verifyValue({ b: 2, a: 1 }, sig, kp.publicKey)).toBe(true);
  });

  it("rejects a tampered value -- this is what makes mandate limits trustworthy", () => {
    const kp = generateKeyPair();
    const value = { mandate_id: "mnd_1", reserved_cents: 500_000 };
    const sig = signValue(value, kp.privateKey);
    expect(verifyValue({ ...value, reserved_cents: 50_000_000 }, sig, kp.publicKey)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const value = { x: 1 };
    expect(verifyValue(value, signValue(value, a.privateKey), b.publicKey)).toBe(false);
  });

  it("returns false rather than throwing on malformed input", () => {
    const kp = generateKeyPair();
    expect(verifyValue({ x: 1 }, "not-a-signature", kp.publicKey)).toBe(false);
    expect(verifyValue({ x: 1 }, "AAAA", "not-a-key")).toBe(false);
  });
});
