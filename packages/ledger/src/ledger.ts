import { DatabaseSync } from "node:sqlite";
import { GENESIS_HASH, canonicalJson, sha256Hex } from "@mercury/core";
import type { EntryBody, EntryInput, EventType, LedgerEntry, VerifyResult } from "./types.js";

/**
 * Ledger -- the witness.
 *
 * An append-only, hash-chained ledger. Every entry commits to the one before it:
 *
 *     hash(n) = sha256( prev_hash(n) || canonicalJson(body(n)) )
 *
 * where body(n) includes its own `seq` and `ts`. Editing any byte of any entry
 * invalidates that entry's hash and every hash after it, so `verify()` reports
 * the exact sequence number where the record was altered.
 *
 * The class exposes no update or delete. That is the point.
 */
export class Ledger {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#migrate();
  }

  /** Open (or create) a ledger at `path`. Use ":memory:" for tests. */
  static open(path: string): Ledger {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    return new Ledger(db);
  }

  get db(): DatabaseSync {
    return this.#db;
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        seq        INTEGER PRIMARY KEY,
        ts         TEXT    NOT NULL,
        event_type TEXT    NOT NULL,
        body       TEXT    NOT NULL,
        prev_hash  TEXT    NOT NULL,
        hash       TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_event_type ON ledger(event_type);
    `);
  }

  /**
   * Append one entry. Assigns `seq` and `ts`, links to the tip, returns the
   * persisted entry. Runs in an IMMEDIATE transaction so two concurrent writers
   * cannot both claim the same sequence number.
   */
  append(input: EntryInput): LedgerEntry {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const tipRow = this.#db
        .prepare("SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1")
        .get() as { seq: number; hash: string } | undefined;

      const seq = (tipRow?.seq ?? 0) + 1;
      const prev_hash = tipRow?.hash ?? GENESIS_HASH;
      const { ts: providedTs, ...rest } = input;

      const body: EntryBody = {
        seq,
        ts: providedTs ?? new Date().toISOString(),
        ...rest,
      } as EntryBody;

      const bodyJson = canonicalJson(body);
      const hash = sha256Hex(prev_hash + bodyJson);

      this.#db
        .prepare(
          "INSERT INTO ledger (seq, ts, event_type, body, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(seq, body.ts, body.event_type, bodyJson, prev_hash, hash);

      this.#db.exec("COMMIT");
      return { ...body, prev_hash, hash };
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Read entries in sequence order. */
  read(opts: { from?: number; limit?: number } = {}): LedgerEntry[] {
    const from = opts.from ?? 1;
    const limit = opts.limit ?? 10_000;
    const rows = this.#db
      .prepare(
        "SELECT seq, ts, event_type, body, prev_hash, hash FROM ledger WHERE seq >= ? ORDER BY seq ASC LIMIT ?",
      )
      .all(from, limit) as unknown as RawRow[];
    return rows.map((r) => ({
      ...(JSON.parse(r.body) as EntryBody),
      prev_hash: r.prev_hash,
      hash: r.hash,
    }));
  }

  byEventType(t: EventType): LedgerEntry[] {
    const rows = this.#db
      .prepare(
        "SELECT seq, ts, event_type, body, prev_hash, hash FROM ledger WHERE event_type = ? ORDER BY seq ASC",
      )
      .all(t) as unknown as RawRow[];
    return rows.map((r) => ({
      ...(JSON.parse(r.body) as EntryBody),
      prev_hash: r.prev_hash,
      hash: r.hash,
    }));
  }

  count(): number {
    const r = this.#db.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number };
    return r.n;
  }

  tipHash(): string {
    const r = this.#db.prepare("SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1").get() as
      | { hash: string }
      | undefined;
    return r?.hash ?? GENESIS_HASH;
  }

  /**
   * Recompute the whole chain and report the first entry that fails.
   *
   * Checks four things per row:
   *   1. `body` parses and its embedded `seq` matches the row's `seq`
   *   2. the `ts` / `event_type` columns agree with the body (so tampering with
   *      an indexed column is caught even though the hash covers only `body`)
   *   3. `prev_hash` equals the previous row's `hash`
   *   4. `hash` equals sha256(prev_hash || body)
   */
  verify(): VerifyResult {
    const rows = this.#db
      .prepare("SELECT seq, ts, event_type, body, prev_hash, hash FROM ledger ORDER BY seq ASC")
      .all() as unknown as RawRow[];

    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;

    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return {
          ok: false,
          count: rows.length,
          broken_at: row.seq,
          reason: "SEQ_GAP",
          detail: `expected seq ${expectedSeq}, found ${row.seq}`,
        };
      }

      let body: EntryBody;
      try {
        body = JSON.parse(row.body) as EntryBody;
      } catch (e) {
        return {
          ok: false,
          count: rows.length,
          broken_at: row.seq,
          reason: "BODY_UNPARSEABLE",
          detail: e instanceof Error ? e.message : String(e),
        };
      }

      if (body.seq !== row.seq || body.ts !== row.ts || body.event_type !== row.event_type) {
        return {
          ok: false,
          count: rows.length,
          broken_at: row.seq,
          reason: "COLUMN_TAMPERED",
          detail:
            `indexed columns disagree with body: ` +
            `seq ${row.seq}/${body.seq}, ts ${row.ts}/${body.ts}, ` +
            `event_type ${row.event_type}/${body.event_type}`,
        };
      }

      if (row.prev_hash !== expectedPrev) {
        return {
          ok: false,
          count: rows.length,
          broken_at: row.seq,
          reason: "PREV_HASH_MISMATCH",
          detail: `prev_hash ${row.prev_hash.slice(0, 12)}... != tip ${expectedPrev.slice(0, 12)}...`,
        };
      }

      const recomputed = sha256Hex(row.prev_hash + row.body);
      if (recomputed !== row.hash) {
        return {
          ok: false,
          count: rows.length,
          broken_at: row.seq,
          reason: "HASH_MISMATCH",
          detail: `stored ${row.hash.slice(0, 12)}... != recomputed ${recomputed.slice(0, 12)}...`,
        };
      }

      expectedPrev = row.hash;
      expectedSeq += 1;
    }

    return { ok: true, count: rows.length };
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  seq: number;
  ts: string;
  event_type: string;
  body: string;
  prev_hash: string;
  hash: string;
}
