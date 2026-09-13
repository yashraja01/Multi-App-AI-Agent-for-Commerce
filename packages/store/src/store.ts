import { DatabaseSync } from "node:sqlite";
import {
  type CatalogItem,
  type IntentToken,
  type MerchantProfile,
  type Cents,
  type SignedBudgetMandate,
  cents,
} from "@mercury/core";

/**
 * The operational store: catalogue, merchants, mandates, tokens, orders.
 *
 * Deliberately separate from the ledger. The ledger records what happened and must be
 * append-only for its hash chain to mean anything; this holds mutable working
 * state. Keeping them in different modules (even though they share one SQLite
 * file) is what stops "update the stock count" from ever touching the audit
 * trail.
 *
 * Two operations here are concurrency-critical and both use BEGIN IMMEDIATE
 * with a conditional UPDATE, so the loser of a race is rejected rather than
 * overwriting the winner:
 *   - reserveStock  (F3, the inventory race)
 *   - spendToken    (F7, intent-token replay)
 */

export interface MandateState {
  consumed_cents: Cents;
  txn_count: number;
  status: "active" | "closed";
}

/**
 * An order row as stored. `merchant_id` and `created_at` are nullable because
 * they arrived by migration and older rows predate them.
 */
export interface OrderRow {
  order_id: string;
  mandate_id: string;
  token_id: string;
  cart_hash: string;
  amount: number;
  status: string;
  payment_id: string | null;
  payment_status: string;
  merchant_id: string | null;
  created_at: string | null;
}

export type StockResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: "INSUFFICIENT"; available: number }
  | { ok: false; reason: "UNKNOWN_SKU"; available: 0 };

export type TokenSpendResult = { ok: true } | { ok: false; reason: "ALREADY_SPENT" | "UNKNOWN" };

/**
 * One external-app action the engine owes the world.
 *
 * Written before the action is attempted, in the same database as the order
 * it follows, so a process that dies between "paid" and "told the owner"
 * finds the debt on restart. `idempotency_key` is the primary key: the same
 * action can be owed once.
 */
export interface OutboxRow {
  idempotency_key: string;
  run_id: string;
  app: string;
  action: string;
  payload: unknown;
  status: "pending" | "done" | "failed";
  attempts: number;
  last_error: string | null;
  result: unknown;
  created_at: string;
  updated_at: string;
  next_attempt_at: string;
}

export class Store {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#migrate();
  }

  static open(path: string): Store {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    return new Store(db);
  }

  get db(): DatabaseSync {
    return this.#db;
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS merchants (
        merchant_id TEXT PRIMARY KEY,
        profile     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS catalog (
        sku         TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        item        TEXT NOT NULL,
        stock       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS catalog_merchant ON catalog(merchant_id);

      CREATE TABLE IF NOT EXISTS principals (
        principal_id TEXT PRIMARY KEY,
        public_key   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mandates (
        mandate_id     TEXT PRIMARY KEY,
        principal_id   TEXT NOT NULL,
        signed         TEXT NOT NULL,
        consumed_cents INTEGER NOT NULL DEFAULT 0,
        txn_count      INTEGER NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS intent_tokens (
        token_id TEXT PRIMARY KEY,
        token    TEXT NOT NULL,
        spent_at TEXT
      );

      CREATE TABLE IF NOT EXISTS orders (
        order_id       TEXT PRIMARY KEY,
        mandate_id     TEXT NOT NULL,
        token_id       TEXT NOT NULL,
        cart_hash      TEXT NOT NULL,
        amount         INTEGER NOT NULL,
        status         TEXT NOT NULL,
        payment_id     TEXT,
        payment_status TEXT NOT NULL DEFAULT 'created'
      );

      CREATE TABLE IF NOT EXISTS holder_nonces (
        nonce   TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS seen_webhook_events (
        event_id TEXT PRIMARY KEY,
        seen_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        idempotency_key TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL,
        app             TEXT NOT NULL,
        action          TEXT NOT NULL,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        result          TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        next_attempt_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (status, next_attempt_at);
    `);

    // `payment_status` arrived with the webhook FSM (F5) and databases seeded
    // before it exist in the wild. ALTER is the whole migration; SQLite has no
    // "ADD COLUMN IF NOT EXISTS", so a second run throwing is the success case.
    try {
      this.#db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'created'");
    } catch {
      /* column already present */
    }

    // `merchant_id` and `created_at` arrived with the merchant console, which
    // lists a merchant's own orders in the order they happened. Same idiom, and
    // the same caveat: rows written before this migration keep NULL and show as
    // unattributed until the next `npm run seed`. Backfilling is not possible --
    // which merchant an old order belonged to is not recoverable from the row.
    for (const col of ["merchant_id TEXT", "created_at TEXT"]) {
      try {
        this.#db.exec(`ALTER TABLE orders ADD COLUMN ${col}`);
      } catch {
        /* column already present */
      }
    }
  }

  /* ------------------------------------------------------------- merchants */

  putMerchant(profile: MerchantProfile): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO merchants (merchant_id, profile) VALUES (?, ?)")
      .run(profile.merchant_id, JSON.stringify(profile));
  }

  getMerchant(merchantId: string): MerchantProfile | undefined {
    const row = this.#db
      .prepare("SELECT profile FROM merchants WHERE merchant_id = ?")
      .get(merchantId) as { profile: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.profile) as MerchantProfile);
  }

  listMerchants(): MerchantProfile[] {
    const rows = this.#db.prepare("SELECT profile FROM merchants").all() as unknown as {
      profile: string;
    }[];
    return rows.map((r) => JSON.parse(r.profile) as MerchantProfile);
  }

  /* --------------------------------------------------------------- catalog */

  putItem(item: CatalogItem): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO catalog (sku, merchant_id, item, stock) VALUES (?, ?, ?, ?)")
      .run(item.sku, item.merchant_id, JSON.stringify(item), item.stock);
  }

  getItem(sku: string): CatalogItem | undefined {
    const row = this.#db.prepare("SELECT item, stock FROM catalog WHERE sku = ?").get(sku) as
      | { item: string; stock: number }
      | undefined;
    if (row === undefined) return undefined;
    // stock is authoritative in its own column so the conditional UPDATE can see it
    return { ...(JSON.parse(row.item) as CatalogItem), stock: row.stock };
  }

  catalogFor(merchantId: string): Map<string, CatalogItem> {
    const rows = this.#db
      .prepare("SELECT item, stock FROM catalog WHERE merchant_id = ?")
      .all(merchantId) as unknown as { item: string; stock: number }[];
    return new Map(
      rows.map((r) => {
        const item = { ...(JSON.parse(r.item) as CatalogItem), stock: r.stock };
        return [item.sku, item];
      }),
    );
  }

  /**
   * F3: atomically reserve stock.
   *
   * BEGIN IMMEDIATE takes the write lock up front, and the UPDATE is guarded by
   * `WHERE stock >= ?`, so two concurrent buyers for the last unit cannot both
   * succeed. The loser gets INSUFFICIENT and never sees a negative stock count.
   */
  reserveStock(sku: string, qty: number): StockResult {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT stock FROM catalog WHERE sku = ?").get(sku) as
        | { stock: number }
        | undefined;

      if (row === undefined) {
        this.#db.exec("ROLLBACK");
        return { ok: false, reason: "UNKNOWN_SKU", available: 0 };
      }

      const res = this.#db
        .prepare("UPDATE catalog SET stock = stock - ? WHERE sku = ? AND stock >= ?")
        .run(qty, sku, qty);

      if (Number(res.changes) === 0) {
        this.#db.exec("ROLLBACK");
        return { ok: false, reason: "INSUFFICIENT", available: row.stock };
      }

      this.#db.exec("COMMIT");
      return { ok: true, remaining: row.stock - qty };
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Put stock back, e.g. after an auto-refund. */
  releaseStock(sku: string, qty: number): void {
    this.#db.prepare("UPDATE catalog SET stock = stock + ? WHERE sku = ?").run(qty, sku);
  }

  /* ------------------------------------------------- principals + mandates */

  putPrincipal(principalId: string, publicKey: string): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO principals (principal_id, public_key) VALUES (?, ?)")
      .run(principalId, publicKey);
  }

  getPrincipalKey(principalId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT public_key FROM principals WHERE principal_id = ?")
      .get(principalId) as { public_key: string } | undefined;
    return row?.public_key;
  }

  putMandate(signed: SignedBudgetMandate): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO mandates (mandate_id, principal_id, signed, consumed_cents, txn_count, status) " +
          "VALUES (?, ?, ?, COALESCE((SELECT consumed_cents FROM mandates WHERE mandate_id = ?), 0), " +
          "COALESCE((SELECT txn_count FROM mandates WHERE mandate_id = ?), 0), 'active')",
      )
      .run(
        signed.mandate.mandate_id,
        signed.mandate.principal_id,
        JSON.stringify(signed),
        signed.mandate.mandate_id,
        signed.mandate.mandate_id,
      );
  }

  getMandate(mandateId: string): SignedBudgetMandate | undefined {
    const row = this.#db
      .prepare("SELECT signed FROM mandates WHERE mandate_id = ?")
      .get(mandateId) as { signed: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.signed) as SignedBudgetMandate);
  }

  getMandateState(mandateId: string): MandateState | undefined {
    const row = this.#db
      .prepare("SELECT consumed_cents, txn_count, status FROM mandates WHERE mandate_id = ?")
      .get(mandateId) as
      | { consumed_cents: number; txn_count: number; status: string }
      | undefined;
    if (row === undefined) return undefined;
    return {
      consumed_cents: cents(row.consumed_cents),
      txn_count: row.txn_count,
      status: row.status === "closed" ? "closed" : "active",
    };
  }

  /** Draw down the envelope. Called only after the gate has allowed the amount. */
  consumeEnvelope(mandateId: string, amount: Cents): MandateState {
    this.#db
      .prepare(
        "UPDATE mandates SET consumed_cents = consumed_cents + ?, txn_count = txn_count + 1 WHERE mandate_id = ?",
      )
      .run(amount, mandateId);
    const state = this.getMandateState(mandateId);
    if (state === undefined) throw new Error(`no such mandate: ${mandateId}`);
    return state;
  }

  /** Give budget back, e.g. after an auto-refund, so the envelope is not silently burned. */
  restoreEnvelope(mandateId: string, amount: Cents): void {
    this.#db
      .prepare(
        "UPDATE mandates SET consumed_cents = MAX(0, consumed_cents - ?), " +
          "txn_count = MAX(0, txn_count - 1) WHERE mandate_id = ?",
      )
      .run(amount, mandateId);
  }

  /**
   * Close an envelope and report the residual that is released back to the
   * principal -- the budget-hold guarantee that unspent authority is not the
   * agent's to keep.
   */
  closeEnvelope(mandateId: string): { released_cents: Cents } {
    const signed = this.getMandate(mandateId);
    const state = this.getMandateState(mandateId);
    if (signed === undefined || state === undefined) throw new Error(`no such mandate: ${mandateId}`);
    this.#db.prepare("UPDATE mandates SET status = 'closed' WHERE mandate_id = ?").run(mandateId);
    return {
      released_cents: cents(Math.max(0, signed.mandate.reserved_cents - state.consumed_cents)),
    };
  }

  /* ---------------------------------------------------------- intent tokens */

  issueToken(token: IntentToken): void {
    this.#db
      .prepare("INSERT INTO intent_tokens (token_id, token, spent_at) VALUES (?, ?, NULL)")
      .run(token.token_id, JSON.stringify(token));
  }

  getToken(tokenId: string): IntentToken | undefined {
    const row = this.#db
      .prepare("SELECT token FROM intent_tokens WHERE token_id = ?")
      .get(tokenId) as { token: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.token) as IntentToken);
  }

  spentTokenIds(): Set<string> {
    const rows = this.#db
      .prepare("SELECT token_id FROM intent_tokens WHERE spent_at IS NOT NULL")
      .all() as unknown as { token_id: string }[];
    return new Set(rows.map((r) => r.token_id));
  }

  /**
   * F7: atomically spend a token exactly once.
   *
   * The conditional UPDATE (`WHERE spent_at IS NULL`) is the whole defence: a
   * replayed token changes zero rows and is rejected, so no second order can
   * ever be created from the same authorisation.
   */
  spendToken(tokenId: string, at: string = new Date().toISOString()): TokenSpendResult {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const exists = this.#db
        .prepare("SELECT 1 AS x FROM intent_tokens WHERE token_id = ?")
        .get(tokenId);
      if (exists === undefined) {
        this.#db.exec("ROLLBACK");
        return { ok: false, reason: "UNKNOWN" };
      }

      const res = this.#db
        .prepare("UPDATE intent_tokens SET spent_at = ? WHERE token_id = ? AND spent_at IS NULL")
        .run(at, tokenId);

      if (Number(res.changes) === 0) {
        this.#db.exec("ROLLBACK");
        return { ok: false, reason: "ALREADY_SPENT" };
      }

      this.#db.exec("COMMIT");
      return { ok: true };
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  /* --------------------------------------------------------- holder proofs */

  /**
   * Burn a proof nonce.
   *
   * Returns false if it was already used. The INSERT is the check: a primary
   * key conflict is the only reliable way to make "seen it before" atomic under
   * two concurrent callers replaying the same proof.
   */
  useHolderNonce(nonce: string, at: string = new Date().toISOString()): boolean {
    try {
      this.#db
        .prepare("INSERT INTO holder_nonces (nonce, seen_at) VALUES (?, ?)")
        .run(nonce, at);
      return true;
    } catch {
      return false;
    }
  }

  seenHolderNonces(): Set<string> {
    const rows = this.#db.prepare("SELECT nonce FROM holder_nonces").all() as unknown as {
      nonce: string;
    }[];
    return new Set(rows.map((r) => r.nonce));
  }

  /* ---------------------------------------------------------------- orders */

  putOrder(o: {
    order_id: string;
    mandate_id: string;
    token_id: string;
    cart_hash: string;
    amount: Cents;
    status: string;
    payment_id?: string;
    merchant_id?: string;
    created_at?: string;
  }): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO orders " +
          "(order_id, mandate_id, token_id, cart_hash, amount, status, payment_id, merchant_id, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        o.order_id,
        o.mandate_id,
        o.token_id,
        o.cart_hash,
        o.amount,
        o.status,
        o.payment_id ?? null,
        o.merchant_id ?? null,
        o.created_at ?? new Date().toISOString(),
      );
  }

  setOrderStatus(orderId: string, status: string, paymentId?: string): void {
    this.#db
      .prepare("UPDATE orders SET status = ?, payment_id = COALESCE(?, payment_id) WHERE order_id = ?")
      .run(status, paymentId ?? null, orderId);
  }

  /**
   * The payment's own status, which advances independently of the order's.
   *
   * Stripe does not guarantee webhook ordering, so this column only ever
   * moves forward -- the caller decides that with `advanceStatus`, and this
   * method just persists the result (F5).
   */
  setPaymentStatus(orderId: string, paymentStatus: string, paymentId?: string): void {
    this.#db
      .prepare(
        "UPDATE orders SET payment_status = ?, payment_id = COALESCE(?, payment_id) WHERE order_id = ?",
      )
      .run(paymentStatus, paymentId ?? null, orderId);
  }

  /** The order a provider payment belongs to, for routing a webhook. */
  orderIdForPayment(paymentId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT order_id FROM orders WHERE payment_id = ?")
      .get(paymentId) as { order_id: string } | undefined;
    return row?.order_id;
  }

  getOrder(orderId: string): OrderRow | undefined {
    return this.#db.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId) as
      | OrderRow
      | undefined;
  }

  /**
   * Recent orders, newest first.
   *
   * `rowid` rather than `created_at`, because rows written before that column
   * existed have none, and insertion order is the truth we actually have. Pass
   * a merchant to scope the list; omit it and you get every merchant's, which
   * is what the demo bench wants and no merchant should ever see.
   */
  listOrders(opts: { merchantId?: string; limit?: number } = {}): OrderRow[] {
    const limit = opts.limit ?? 50;
    return opts.merchantId === undefined
      ? (this.#db
          .prepare("SELECT * FROM orders ORDER BY rowid DESC LIMIT ?")
          .all(limit) as unknown as OrderRow[])
      : (this.#db
          .prepare("SELECT * FROM orders WHERE merchant_id = ? ORDER BY rowid DESC LIMIT ?")
          .all(opts.merchantId, limit) as unknown as OrderRow[]);
  }

  /* ----------------------------------------------------- webhook dedupe ---- */

  hasSeenEvent(eventId: string): boolean {
    return (
      this.#db.prepare("SELECT 1 AS x FROM seen_webhook_events WHERE event_id = ?").get(eventId) !==
      undefined
    );
  }

  markEventSeen(eventId: string): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO seen_webhook_events (event_id, seen_at) VALUES (?, ?)")
      .run(eventId, new Date().toISOString());
  }

  /* --------------------------------------------------------------- outbox --- */

  /** Record the debt. Returns false if the key is already owed or paid. */
  enqueueOutbox(row: {
    idempotency_key: string;
    run_id: string;
    app: string;
    action: string;
    payload: unknown;
    at?: string;
  }): boolean {
    const at = row.at ?? new Date().toISOString();
    const r = this.#db
      .prepare(
        `INSERT OR IGNORE INTO outbox
           (idempotency_key, run_id, app, action, payload, status, attempts, created_at, updated_at, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(row.idempotency_key, row.run_id, row.app, row.action, JSON.stringify(row.payload), at, at, at);
    return Number(r.changes) === 1;
  }

  getOutbox(key: string): OutboxRow | undefined {
    const row = this.#db.prepare("SELECT * FROM outbox WHERE idempotency_key = ?").get(key) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : outboxRowOf(row);
  }

  /** Pending rows whose next attempt is due, oldest first. */
  dueOutbox(now: string = new Date().toISOString(), limit = 50): OutboxRow[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT ?",
      )
      .all(now, limit) as unknown as Record<string, unknown>[];
    return rows.map(outboxRowOf);
  }

  listOutbox(opts: { run_id?: string; limit?: number } = {}): OutboxRow[] {
    const rows = (
      opts.run_id === undefined
        ? this.#db.prepare("SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?").all(opts.limit ?? 100)
        : this.#db
            .prepare("SELECT * FROM outbox WHERE run_id = ? ORDER BY created_at LIMIT ?")
            .all(opts.run_id, opts.limit ?? 100)
    ) as unknown as Record<string, unknown>[];
    return rows.map(outboxRowOf);
  }

  /** The action landed. */
  completeOutbox(key: string, result: unknown, at: string = new Date().toISOString()): void {
    this.#db
      .prepare(
        "UPDATE outbox SET status = 'done', result = ?, attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE idempotency_key = ?",
      )
      .run(JSON.stringify(result), at, key);
  }

  /**
   * The attempt failed. Either schedule the next one or, once the budget is
   * spent, mark the row failed for an operator. Returns the row as it now is.
   */
  failOutbox(key: string, error: string, nextAttemptAt: string | undefined, at: string = new Date().toISOString()): OutboxRow | undefined {
    if (nextAttemptAt === undefined) {
      this.#db
        .prepare(
          "UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE idempotency_key = ?",
        )
        .run(error, at, key);
    } else {
      this.#db
        .prepare(
          "UPDATE outbox SET attempts = attempts + 1, last_error = ?, updated_at = ?, next_attempt_at = ? WHERE idempotency_key = ?",
        )
        .run(error, at, nextAttemptAt, key);
    }
    return this.getOutbox(key);
  }

  /* ------------------------------------------------------- freeze switch --- */

  isFrozen(): boolean {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = 'frozen'").get() as
      | { value: string }
      | undefined;
    return row?.value === "1";
  }

  setFrozen(frozen: boolean): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('frozen', ?)")
      .run(frozen ? "1" : "0");
  }

  close(): void {
    this.#db.close();
  }
}

function outboxRowOf(row: Record<string, unknown>): OutboxRow {
  return {
    idempotency_key: String(row["idempotency_key"]),
    run_id: String(row["run_id"]),
    app: String(row["app"]),
    action: String(row["action"]),
    payload: JSON.parse(String(row["payload"])) as unknown,
    status: String(row["status"]) as OutboxRow["status"],
    attempts: Number(row["attempts"]),
    last_error: row["last_error"] === null || row["last_error"] === undefined ? null : String(row["last_error"]),
    result: row["result"] === null || row["result"] === undefined ? null : (JSON.parse(String(row["result"])) as unknown),
    created_at: String(row["created_at"]),
    updated_at: String(row["updated_at"]),
    next_attempt_at: String(row["next_attempt_at"]),
  };
}
