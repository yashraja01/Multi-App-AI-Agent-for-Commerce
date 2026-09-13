import { zHolderProof } from "@mercury/core";
import { TransactError, pay } from "@/lib/transact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Redeem exactly one intent token against exactly one order. */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as {
      order_id?: string;
      intent_token_id?: string;
      session_id?: string;
      holder_proof?: unknown;
      simulate_failure?: boolean;
    };

    if (typeof body.order_id !== "string" || typeof body.intent_token_id !== "string") {
      return Response.json({ error: "order_id and intent_token_id are required" }, { status: 400 });
    }

    const parsed = zHolderProof.safeParse(body.holder_proof);
    if (!parsed.success) {
      return Response.json(
        { error: "holder_proof is required to redeem a token", rule_id: "HOLDER.PROOF_MISSING" },
        { status: 401 },
      );
    }

    const result = await pay({
      holder_proof: parsed.data,
      order_id: body.order_id,
      intent_token_id: body.intent_token_id,
      ...(typeof body.session_id === "string" ? { session_id: body.session_id } : {}),
      ...(body.simulate_failure === true ? { simulate_failure: true } : {}),
    });
    return Response.json(result);
  } catch (e) {
    if (e instanceof TransactError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
