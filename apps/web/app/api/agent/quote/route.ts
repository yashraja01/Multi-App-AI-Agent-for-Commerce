import { zHolderProof } from "@mercury/core";
import { TransactError, quote } from "@/lib/transact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Negotiate a cart.
 *
 * The request body carries a merchant, a mandate and a sentence. It carries no
 * price, because a buyer naming a price is exactly the thing this system is
 * built to make impossible.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as {
      merchant_id?: string;
      mandate_id?: string;
      message?: string;
      mode?: string;
      holder_proof?: unknown;
    };

    if (typeof body.merchant_id !== "string" || typeof body.mandate_id !== "string") {
      return Response.json({ error: "merchant_id and mandate_id are required" }, { status: 400 });
    }
    if (typeof body.message !== "string" || body.message.trim() === "") {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    const parsed = zHolderProof.safeParse(body.holder_proof);
    if (!parsed.success) {
      return Response.json(
        {
          error:
            "holder_proof is required: sign {mandate_id, nonce, issued_at} with the agent key " +
            "named in the mandate. A mandate id on its own is not authority.",
          rule_id: "HOLDER.PROOF_MISSING",
        },
        { status: 401 },
      );
    }

    const result = await quote({
      merchant_id: body.merchant_id,
      mandate_id: body.mandate_id,
      message: body.message,
      holder_proof: parsed.data,
      ...(body.mode === "llm" ? { mode: "llm" as const } : {}),
    });
    return Response.json(result, { status: result.outcome === "DENY" ? 200 : 200 });
  } catch (e) {
    if (e instanceof TransactError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
