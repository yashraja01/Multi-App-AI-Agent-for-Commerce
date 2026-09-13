import { createHash } from "node:crypto";

/**
 * Canonical JSON: deterministic bytes for the same logical value.
 *
 * the ledger's hash chain and the gate's cart hashes both depend on two different
 * processes producing byte-identical serialisations. `JSON.stringify` does not
 * guarantee that (key order follows insertion order), so we sort keys
 * recursively and reject values that have no canonical form.
 *
 * Rules:
 *   - object keys sorted by UTF-16 code unit (Array.prototype.sort default)
 *   - `undefined` object properties are omitted (they have no JSON form)
 *   - `undefined` inside an array is an error (silent null-coercion would let
 *     two different values hash the same)
 *   - non-finite numbers are an error
 *   - no whitespace
 */
export function canonicalJson(value: unknown): string {
  return ser(value, []);
}

function ser(v: unknown, path: string[]): string {
  if (v === null) return "null";

  const t = typeof v;

  if (t === "string") return JSON.stringify(v);

  if (t === "number") {
    if (!Number.isFinite(v as number)) {
      throw new CanonicalError(`non-finite number at ${fmtPath(path)}: ${String(v)}`);
    }
    // Integers and JS doubles both round-trip exactly through String() here;
    // -0 is normalised to 0 so it cannot produce a second hash for one value.
    const n = v as number;
    return Object.is(n, -0) ? "0" : String(n);
  }

  if (t === "boolean") return v ? "true" : "false";

  if (t === "bigint") {
    throw new CanonicalError(`bigint has no canonical JSON form at ${fmtPath(path)}`);
  }

  if (t === "undefined") {
    throw new CanonicalError(`undefined at ${fmtPath(path)}`);
  }

  if (t === "function" || t === "symbol") {
    throw new CanonicalError(`${t} is not serialisable at ${fmtPath(path)}`);
  }

  if (Array.isArray(v)) {
    const parts = v.map((item, i) => {
      if (item === undefined) {
        throw new CanonicalError(`undefined array element at ${fmtPath([...path, String(i)])}`);
      }
      return ser(item, [...path, String(i)]);
    });
    return `[${parts.join(",")}]`;
  }

  if (v instanceof Date) {
    throw new CanonicalError(
      `Date at ${fmtPath(path)}: convert to an ISO string before hashing`,
    );
  }

  // Plain object
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const val = obj[k];
    if (val === undefined) continue; // omit, matching JSON.stringify
    parts.push(`${JSON.stringify(k)}:${ser(val, [...path, k])}`);
  }
  return `{${parts.join(",")}}`;
}

function fmtPath(path: string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

/** sha256 of a UTF-8 string, hex-encoded. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** sha256 of the canonical JSON form of `value`, hex-encoded. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** The 64-zero hash that seeds a chain. */
export const GENESIS_HASH = "0".repeat(64);
