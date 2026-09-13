import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalJson } from "./canonical.js";

/**
 * Ed25519 detached signatures over canonical JSON.
 *
 * A mandate carries its own limits, so the signature is what makes those limits
 * trustworthy: any party can verify the envelope was authorised by the
 * principal and has not been edited in flight.
 *
 * Keys are exchanged as base64url of the raw 32-byte key material, which is
 * what an Ed25519 JWK `x` / `d` parameter holds.
 */

export interface KeyPairB64 {
  /** base64url raw 32-byte public key. */
  publicKey: string;
  /** base64url raw 32-byte private key seed. */
  privateKey: string;
}

export function generateKeyPair(): KeyPairB64 {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: rawPublicToB64(publicKey),
    privateKey: rawPrivateToB64(privateKey),
  };
}

/** Sign the canonical JSON form of `value`. Returns a base64url signature. */
export function signValue(value: unknown, privateKeyB64: string): string {
  const key = privateKeyFromB64(privateKeyB64);
  const sig = nodeSign(null, Buffer.from(canonicalJson(value), "utf8"), key);
  return sig.toString("base64url");
}

/**
 * Verify a detached signature over the canonical JSON form of `value`.
 * Returns false rather than throwing on malformed keys or signatures, so a
 * caller can treat every failure mode as one boolean.
 */
export function verifyValue(
  value: unknown,
  signatureB64: string,
  publicKeyB64: string,
): boolean {
  try {
    const key = publicKeyFromB64(publicKeyB64);
    return nodeVerify(
      null,
      Buffer.from(canonicalJson(value), "utf8"),
      key,
      Buffer.from(signatureB64, "base64url"),
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ key conversions */

// Ed25519 SPKI DER prefix for a raw 32-byte public key.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
// Ed25519 PKCS8 DER prefix for a raw 32-byte private seed.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function publicKeyFromB64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64url");
  if (raw.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function privateKeyFromB64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64url");
  if (raw.length !== 32) throw new Error(`ed25519 private key must be 32 bytes, got ${raw.length}`);
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function rawPublicToB64(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
}

function rawPrivateToB64(key: KeyObject): string {
  const der = key.export({ format: "der", type: "pkcs8" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
}
