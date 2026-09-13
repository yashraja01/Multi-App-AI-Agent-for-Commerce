/**
 * Display helpers.
 *
 * Deliberately local to the web app rather than imported from `@mercury/core`:
 * that package reaches for `node:crypto`, and nothing that formats a number for
 * a browser should be able to drag the signing code into a client bundle.
 *
 * These format money. They never do arithmetic on it.
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

export function dollars(p: number): string {
  return USD.format(p / 100);
}

/** Cents, grouped, for when the exact integer matters more than the dollar value. */
export function centsExact(p: number): string {
  return `${new Intl.NumberFormat("en-US").format(p)} cents`;
}

/**
 * Basis points as a percentage. `1500` -> `15%`, `1825` -> `18.25%`.
 *
 * Trailing zeros are trimmed because a margin floor of exactly 15% should read
 * as "15%", not "15.00%" — the extra digits imply a precision the merchant did
 * not set. Pass `sign` for a figure that is meaningfully positive or negative,
 * like an uplift.
 */
export function bps(n: number, opts?: { sign?: boolean }): string {
  const pct = n / 100;
  const body = `${Number(pct.toFixed(2))}%`;
  return opts?.sign === true && n > 0 ? `+${body}` : body;
}

/**
 * Basis points as a plain percentage, for a merchant reading a sentence.
 *
 * `bps()` is for the operator's surfaces, where the unit is the point. This is
 * for "Never sell below 15% margin", where the unit would be noise: nobody sets
 * a floor thinking in ten-thousandths.
 */
export function percent(bpsValue: number): string {
  return `${Number((bpsValue / 100).toFixed(2))}%`;
}

/** Dollars with no cents, for a figure being typed rather than reported. */
export function dollarsRound(p: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(p / 100);
}

export function shortHash(h: string, n = 10): string {
  return h.slice(0, n);
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "--:--:--"
    : d.toLocaleTimeString("en-GB", { hour12: false });
}
