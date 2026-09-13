import type { EventType } from "@mercury/ledger";

/**
 * The wire shape of the Chaos Console.
 *
 * Split out of `chaos.ts` for the same reason `types.ts` is split out of
 * `run.ts`: that module is `server-only`, and the panel that renders these
 * results must not be able to pull the engine into the browser bundle with them.
 */

export type FailureId = "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11";

export interface ChaosRow {
  id: FailureId;
  failure: string;
  injection: string;
  expected: string;
  /** The ledger events this row must produce, from the failure-audit table. */
  ledger: EventType[];
}

export interface ChaosCheck {
  label: string;
  passed: boolean;
  detail: string;
}

export interface ChaosResult extends ChaosRow {
  passed: boolean;
  /**
   * The row never ran because the bench had nothing left to spend.
   *
   * Deliberately distinct from `passed: false`. A spent bench is a fact about
   * the demo data, not a finding about the gate, and conflating the two is how
   * a table of green rows quietly turns into a table of red ones that nobody
   * trusts. Blocked rows are reported separately and never counted as failures.
   */
  blocked: boolean;
  checks: ChaosCheck[];
  /** Every event type the run actually wrote, deduplicated, in order. */
  observed: string[];
  ledger_from: number;
  ledger_to: number;
  duration_ms: number;
  bench: BenchStatus;
}

/**
 * How much demo budget the chaos bench has left.
 *
 * The rows that need a live order buy one through the same gate as everything
 * else, which means the bench is finite: a mandate with eight debits, an
 * envelope, and real stock behind it. This is that state, made visible before
 * it becomes a confusing red row.
 */
export interface BenchStatus {
  mandate_id: string;
  txn_count: number;
  max_txn_count: number;
  remaining_cents: number;
  reserved_cents: number;
  /** Stock of the SKUs the bench buys from, by sku. */
  stock: { sku: string; available: number }[];
  /** Whole passes over the table the bench can still afford. */
  runs_left: number;
  /** False when even a single order-taking row would be denied at setup. */
  ready: boolean;
  /** Why not, in one line, when `ready` is false. */
  reason: string | null;
}
