import {
  type CatalogItem,
  type MerchantProfile,
  type Proposal,
  formatUSD,
  mulP,
  sumP,
} from "@mercury/core";
import { lowestLegalUnit } from "./pricing.js";

/**
 * Auto-repair.
 *
 * When the Revenue Agent proposes a price the gate rejects, we do not simply fail
 * the negotiation -- we clamp the offer up to the lowest price the merchant
 * would actually accept and hand that back to the agent as a fact. The agent
 * then re-quotes legally.
 *
 * This is deliberately a separate function from `evaluate`: the gate decides,
 * and repair is a distinct, also-deterministic step. Repair never lowers a
 * price and never invents a SKU.
 */

export interface RepairResult {
  proposal: Proposal;
  /** Human-readable, deterministic notes -- one per line that moved. */
  adjustments: string[];
  changed: boolean;
}

export function repairProposal(
  proposal: Proposal,
  profile: MerchantProfile,
  catalog: ReadonlyMap<string, CatalogItem>,
): RepairResult {
  const adjustments: string[] = [];
  let changed = false;

  const lines = proposal.lines.map((pl) => {
    const item = catalog.get(pl.sku);
    if (item === undefined) return pl; // evaluate() will deny on CATALOG.UNKNOWN_SKU

    const lowest = lowestLegalUnit(item, profile);
    if (pl.offer_unit_cents >= lowest) return pl;

    changed = true;
    adjustments.push(
      `${pl.sku}: ${formatUSD(pl.offer_unit_cents)} -> ${formatUSD(lowest)} per ${item.unit} ` +
        `(lowest price permitted by the margin floor and discount ceiling)`,
    );
    return { ...pl, offer_unit_cents: lowest };
  });

  const recomputedTotal = sumP(lines.map((l) => mulP(l.offer_unit_cents, l.qty)));

  return {
    proposal: { ...proposal, lines, quoted_total_cents: recomputedTotal },
    adjustments,
    changed,
  };
}
