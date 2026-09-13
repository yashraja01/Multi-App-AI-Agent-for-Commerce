import { mercury } from "@/lib/mercury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Machine-readable product feed.
 *
 * UCP/ACP feed shape: stable ids, integer minor units with an explicit
 * currency, and availability that reflects real stock rather than a marketing
 * flag. Landed cost and the margin floor are absent -- a feed is public, and
 * the merchant's own economics are not a buyer's business.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ merchant: string }> },
): Promise<Response> {
  const { merchant } = await ctx.params;
  const m = mercury();
  const profile = m.store.getMerchant(merchant);
  if (profile === undefined) {
    return Response.json({ error: `no such merchant: ${merchant}` }, { status: 404 });
  }

  const origin = new URL(req.url).origin;
  const items = [...m.store.catalogFor(merchant).values()].sort((a, b) =>
    a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0,
  );

  return Response.json(
    {
      version: "1.0",
      merchant: {
        id: profile.merchant_id,
        name: profile.display_name,
        vertical: profile.vertical,
        agent_card: `${origin}/.well-known/agent.json`,
      },
      currency: "USD",
      minor_unit: "cents",
      generated_at: new Date().toISOString(),
      count: items.length,
      products: items.map((i) => ({
        id: i.sku,
        title: i.title,
        category: i.category,
        ...(i.gtin === undefined ? {} : { gtin: i.gtin }),
        unit: i.unit,
        price: { amount: i.list_cents, currency: "USD", minor_unit: "cents" },
        availability: i.stock > 0 ? "in_stock" : "out_of_stock",
        inventory_quantity: i.stock,
        min_order_quantity: i.moq,
      })),
      // Stated in the feed so a buyer agent knows the rules before it quotes.
      negotiation: {
        supported: true,
        levers: profile.levers,
        note: "List price is the ceiling for a buyer's expectations, not the floor. The floor is enforced by the merchant's gate and is not published.",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
