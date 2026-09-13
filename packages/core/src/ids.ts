import { randomBytes, randomUUID } from "node:crypto";

/**
 * Prefixed identifiers. The prefix makes every id self-describing in logs,
 * in the ledger, and in the payment provider's metadata.
 */
export const ID_PREFIX = {
  mandate: "mnd",
  cart: "crt",
  intentToken: "itk",
  agent: "agt",
  principal: "prn",
  merchant: "mch",
  session: "ses",
  order: "ord",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

/** Generate a random prefixed id, e.g. `mnd_9f2c1a7b4d6e8f01`. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${randomBytes(8).toString("hex")}`;
}

/** A single-use nonce for replay defence. */
export function newNonce(): string {
  return randomUUID();
}

export function isId(kind: IdKind, value: string): boolean {
  return value.startsWith(`${ID_PREFIX[kind]}_`);
}

/**
 * The rail's `receipt` must be unique and <= 40 characters. We derive it from the
 * intent token so a receipt is traceable back to exactly one authorisation.
 */
export function receiptFor(intentTokenId: string): string {
  const r = `mrc_${intentTokenId}`;
  return r.length <= 40 ? r : r.slice(0, 40);
}
