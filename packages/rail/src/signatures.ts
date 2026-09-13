import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe webhook signatures.
 *
 * Stripe signs `${timestamp}.${raw_body}` with the endpoint's `whsec_...`
 * secret and delivers the result in one header:
 *
 *   Stripe-Signature: t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
 *
 * Two things about it that matter here:
 *
 *  - The message is the RAW body. Parsing JSON and re-serialising it before
 *    verifying will silently change the bytes and fail every time -- which is
 *    why everything downstream takes a string, never an object.
 *  - The timestamp is part of the signed message, so a captured delivery
 *    cannot be replayed indefinitely: outside the tolerance window it is
 *    rejected even though the HMAC is genuine.
 *
 * Stripe may send several `v1=` values while a secret is being rotated. Any one
 * matching is a pass.
 */

export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Constant-time comparison of two hex digests. */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function computeWebhookSignature(rawBody: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/** Build a `Stripe-Signature` header the way Stripe does. For tests and the fixture. */
export function signWebhookHeader(rawBody: string, secret: string, timestamp: number): string {
  return `t=${timestamp},v1=${computeWebhookSignature(rawBody, secret, timestamp)}`;
}

export interface ParsedSignatureHeader {
  timestamp: number;
  signatures: string[];
}

export function parseSignatureHeader(header: string): ParsedSignatureHeader | undefined {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const n = Number.parseInt(value, 10);
      if (Number.isSafeInteger(n)) timestamp = n;
    } else if (key === "v1" && /^[0-9a-f]+$/iu.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === undefined || signatures.length === 0) return undefined;
  return { timestamp, signatures };
}

export function verifyWebhookSignature(
  rawBody: string,
  header: string,
  secret: string,
  opts: { now?: () => number; toleranceSeconds?: number } = {},
): { ok: true } | { ok: false; reason: string } {
  const parsed = parseSignatureHeader(header);
  if (parsed === undefined) {
    return { ok: false, reason: "signature header is not in Stripe's t=...,v1=... form" };
  }

  const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: `timestamp outside the ${tolerance}s tolerance window` };
  }

  const expected = computeWebhookSignature(rawBody, secret, parsed.timestamp);
  if (!parsed.signatures.some((s) => hexEqual(s, expected))) {
    return { ok: false, reason: "signature does not match the raw body" };
  }
  return { ok: true };
}
