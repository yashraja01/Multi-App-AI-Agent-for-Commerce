import { describe, expect, it } from "vitest";
import { type HolderProof, generateKeyPair, holderChallenge, signValue } from "@mercury/core";
import { evaluate } from "./evaluate.js";
import { AGENT_KEYS, NOW, inputOf } from "./testkit.js";

/**
 * Proof of holder.
 *
 * A signed mandate proves the envelope is genuine. It does not prove the caller
 * is the agent the envelope was issued to. Without these rules a mandate id is
 * a bearer token, and every other limit in the system is only as strong as the
 * secrecy of a string that travels in request bodies.
 */

function proofFor(
  over: Partial<HolderProof> = {},
  privateKey: string = AGENT_KEYS.privateKey,
): HolderProof {
  const body = {
    mandate_id: over.mandate_id ?? "mnd_test",
    nonce: over.nonce ?? "nonce-0123456789",
    issued_at: over.issued_at ?? NOW.toISOString(),
  };
  return {
    ...body,
    signature: over.signature ?? signValue(holderChallenge(body), privateKey),
  };
}

describe("HOLDER: proving the caller holds the mandate", () => {
  it("allows a correctly signed proof", () => {
    const d = evaluate(inputOf({ require_holder_proof: true, holder_proof: proofFor() }));

    expect(d.outcome).not.toBe("DENY");
    expect(d.rules.find((r) => r.rule_id === "HOLDER.SIGNATURE")?.passed).toBe(true);
  });

  it("denies when no proof is supplied at all", () => {
    const d = evaluate(inputOf({ require_holder_proof: true }));

    expect(d.outcome).toBe("DENY");
    if (d.outcome !== "DENY") throw new Error("unreachable");
    expect(d.violation.rule_id).toBe("HOLDER.PROOF_MISSING");
  });

  it("denies a proof signed by the wrong key", () => {
    const impostor = generateKeyPair();
    const d = evaluate(
      inputOf({ require_holder_proof: true, holder_proof: proofFor({}, impostor.privateKey) }),
    );

    expect(d.outcome).toBe("DENY");
    if (d.outcome !== "DENY") throw new Error("unreachable");
    expect(d.violation.rule_id).toBe("HOLDER.SIGNATURE");
  });

  it("denies a proof whose body was altered after signing", () => {
    const genuine = proofFor();
    const tampered: HolderProof = { ...genuine, nonce: "different-nonce-99" };
    const d = evaluate(inputOf({ require_holder_proof: true, holder_proof: tampered }));

    expect(d.outcome).toBe("DENY");
    if (d.outcome !== "DENY") throw new Error("unreachable");
    expect(d.violation.rule_id).toBe("HOLDER.SIGNATURE");
  });

  it("denies a proof made for a different mandate", () => {
    const d = evaluate(
      inputOf({
        require_holder_proof: true,
        holder_proof: proofFor({ mandate_id: "mnd_someone_else" }),
      }),
    );

    expect(d.outcome).toBe("DENY");
    if (d.outcome !== "DENY") throw new Error("unreachable");
    expect(d.violation.rule_id).toBe("HOLDER.SIGNATURE");
  });

  it("denies a replayed nonce even though the signature is genuine", () => {
    const proof = proofFor();
    const d = evaluate(
      inputOf({
        require_holder_proof: true,
        holder_proof: proof,
        seen_holder_nonces: new Set([proof.nonce]),
      }),
    );

    expect(d.outcome).toBe("DENY");
    if (d.outcome !== "DENY") throw new Error("unreachable");
    expect(d.violation.rule_id).toBe("HOLDER.NONCE_REPLAY");
  });

  it("denies a proof issued outside the clock-skew window", () => {
    const stale = proofFor({
      issued_at: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    });
    const d = evaluate({
      ...inputOf({ require_holder_proof: true, holder_proof: stale }),
      holder_proof_skew_ms: 120_000,
    });

    expect(d.outcome).toBe("DENY");
    if (d.outcome !== "DENY") throw new Error("unreachable");
    expect(d.violation.rule_id).toBe("HOLDER.STALE");
  });

  it("denies a proof from the future, not just a stale one", () => {
    const ahead = proofFor({
      issued_at: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    });
    const d = evaluate(inputOf({ require_holder_proof: true, holder_proof: ahead }));

    expect(d.outcome).toBe("DENY");
    if (d.outcome !== "DENY") throw new Error("unreachable");
    expect(d.violation.rule_id).toBe("HOLDER.STALE");
  });

  it("does not evaluate holder rules when proof is not required", () => {
    // The merchant's own console. The exemption is explicit, and its absence
    // from the rule list is what makes it auditable.
    const d = evaluate(inputOf({ require_holder_proof: false }));

    expect(d.outcome).not.toBe("DENY");
    expect(d.rules.some((r) => r.rule_id.startsWith("HOLDER."))).toBe(false);
  });

  it("checks the holder before anything about the cart", () => {
    // A caller who cannot prove it holds the mandate must not learn whether its
    // basket would have been affordable.
    const d = evaluate(inputOf({ require_holder_proof: true }));

    if (d.outcome !== "DENY") throw new Error("unreachable");
    expect(d.rules.some((r) => r.rule_id.startsWith("MANDATE.PER_TXN"))).toBe(false);
    expect(d.rules.some((r) => r.rule_id.startsWith("CATALOG."))).toBe(false);
  });
});
