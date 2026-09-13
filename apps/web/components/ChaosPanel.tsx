"use client";

import { useCallback, useEffect, useState } from "react";
import type { BenchStatus, ChaosResult, ChaosRow } from "@/lib/chaos-types";
import { dollars } from "@/lib/format";
import { Pill } from "./ui/Pill";

/**
 * The Chaos Console.
 *
 * The failure-audit table, rendered as something you can press. Each row breaks
 * the system in one specific way and then checks the recovery: the ledger
 * entries the row promises, and the state that must not have moved. A row is
 * green only when every one of its checks holds, which is why the checks are
 * shown individually rather than as a single verdict.
 *
 * The panel decides nothing. It posts to /api/chaos and renders what came back.
 */

type Status = "idle" | "running" | "pass" | "fail" | "blocked";

function statusOf(row: ChaosRow, results: Record<string, ChaosResult>, running: string | null): Status {
  if (running === row.id) return "running";
  const r = results[row.id];
  if (r === undefined) return "idle";
  if (r.blocked) return "blocked";
  return r.passed ? "pass" : "fail";
}

/*
 * A blocked row is brass, not vermilion, and reads "bench spent" rather than
 * "failed". The distinction is the whole point: the demo data ran out, the gate
 * did not misbehave, and a red row here would be a lie about the system.
 */
const PILL: Record<Status, { text: string; className: string }> = {
  idle: { text: "not run", className: "border-rule text-paper-faint" },
  running: { text: "running", className: "border-brass text-brass" },
  pass: { text: "verified", className: "border-verdigris text-verdigris" },
  fail: { text: "failed", className: "border-vermilion text-vermilion" },
  blocked: { text: "bench spent", className: "border-brass text-brass" },
};

/** The bench's remaining budget, stated before it becomes a confusing red row. */
function Bench({
  bench,
  onReset,
  busy,
}: {
  bench: BenchStatus | null;
  onReset: () => void;
  busy: boolean;
}) {
  if (bench === null) return null;
  const spent = !bench.ready;

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 border px-3 py-2 text-[12px] ${
        spent ? "border-brass bg-brass/[0.06]" : "border-rule"
      }`}
    >
      <span className="eyebrow">bench</span>
      <span className={spent ? "text-brass" : "text-paper-dim"}>
        {bench.txn_count}/{bench.max_txn_count} debits used &middot; {dollars(bench.remaining_cents)}{" "}
        left &middot;{" "}
        {bench.stock.map((s) => `${s.sku.replace(/^QC_/u, "")} x${s.available}`).join(" · ")}
      </span>
      <span className={`figures ${spent ? "text-brass" : "text-paper-faint"}`}>
        {spent
          ? `spent — ${bench.reason ?? ""}`
          : `${bench.runs_left} full ${bench.runs_left === 1 ? "pass" : "passes"} left`}
      </span>
      {spent || bench.runs_left <= 1 ? (
        <button
          type="button"
          onClick={onReset}
          disabled={busy}
          className="border border-brass px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-brass transition-colors hover:bg-brass/15 disabled:opacity-30"
        >
          Reset bench
        </button>
      ) : null}
    </div>
  );
}

function Row({
  row,
  result,
  status,
  expanded,
  onToggle,
  onRun,
  busy,
}: {
  row: ChaosRow;
  result: ChaosResult | undefined;
  status: Status;
  expanded: boolean;
  onToggle: () => void;
  onRun: () => void;
  busy: boolean;
}) {
  const pill = PILL[status];

  return (
    <div className="border-b border-rule last:border-0">
      <div className="flex items-baseline gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          className="figures w-[26px] shrink-0 text-left text-[12px] text-brass"
        >
          {row.id}
        </button>

        <div className="min-w-0 flex-1">
          <button type="button" onClick={onToggle} className="block text-left">
            <span className="text-[13px] text-paper">{row.failure}</span>
            <span className="ml-2 text-[12px] text-paper-faint">{row.injection}</span>
          </button>

          {expanded ? (
            <div className="mt-2 space-y-2">
              <p className="max-w-[78ch] text-[12px] leading-relaxed text-paper-dim">
                Expected: {row.expected}.
              </p>
              {result === undefined ? null : (
                <ul className="space-y-1">
                  {result.checks.map((c) => (
                    <li key={c.label} className="flex gap-2 text-[12px]">
                      <span
                        className={`figures shrink-0 ${
                          c.passed ? "text-verdigris" : "text-vermilion"
                        }`}
                      >
                        {c.passed ? "ok" : "xx"}
                      </span>
                      <span className="text-paper-dim">
                        {c.label}
                        <span className="ml-2 text-paper-faint">— {c.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {result === undefined ? null : (
                <p className="figures text-[11px] text-paper-faint">
                  ledger {result.ledger_from}–{result.ledger_to} · {result.duration_ms}ms ·{" "}
                  {result.observed.join(" · ")}
                </p>
              )}
            </div>
          ) : null}
        </div>

        <Pill className={pill.className}>{pill.text}</Pill>

        <button
          type="button"
          onClick={onRun}
          disabled={busy}
          className="shrink-0 border border-rule px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-paper-dim transition-colors hover:border-rule-bright hover:text-paper disabled:opacity-30"
        >
          Break it
        </button>
      </div>
    </div>
  );
}

export function ChaosPanel({ onSettled }: { onSettled: () => void | Promise<void> }) {
  const [rows, setRows] = useState<ChaosRow[]>([]);
  const [bench, setBench] = useState<BenchStatus | null>(null);
  const [results, setResults] = useState<Record<string, ChaosResult>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [all, setAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** The chain, re-verified after the whole table has run. */
  const [chain, setChain] = useState<{ ok: boolean; count: number } | null>(null);

  const refreshBench = useCallback(async () => {
    const res = await fetch("/api/chaos", { cache: "no-store" });
    const body = (await res.json()) as { rows: ChaosRow[]; bench: BenchStatus };
    setRows(body.rows);
    setBench(body.bench);
  }, []);

  useEffect(() => {
    void refreshBench();
  }, [refreshBench]);

  /**
   * Re-seed the demo data.
   *
   * Deliberately a button and never automatic. Reset destroys the database, and
   * the ledger chain is the artifact this whole product asks to be trusted on;
   * wiping it out from under someone mid-demo to keep a bench topped up would
   * be the wrong trade every time.
   */
  const resetBench = useCallback(async () => {
    setResetting(true);
    setResults({});
    await fetch("/api/reset", { method: "POST" });
    await refreshBench();
    await onSettled();
    setResetting(false);
  }, [refreshBench, onSettled]);

  const runOne = useCallback(
    async (id: string): Promise<ChaosResult | undefined> => {
      setRunning(id);
      setExpanded(id);
      try {
        const res = await fetch("/api/chaos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        const body = (await res.json()) as ChaosResult & { error?: string };
        if (body.error !== undefined) return undefined;
        setResults((prev) => ({ ...prev, [id]: body }));
        setBench(body.bench);
        return body;
      } finally {
        setRunning(null);
        await onSettled();
      }
    },
    [onSettled],
  );

  const runAll = useCallback(async () => {
    setAll(true);
    setResults({});
    setChain(null);
    for (const row of rows) {
      const result = await runOne(row.id);
      // No point grinding through the remaining rows to watch them block for
      // the same reason; stop, and let the operator decide to reset.
      if (result?.blocked === true) break;
    }
    // Eleven faults later, the record must still hold together.
    const res = await fetch("/api/verify", { method: "POST" });
    const v = (await res.json()) as { ok?: boolean; count?: number };
    setChain({ ok: v.ok === true, count: v.count ?? 0 });
    setAll(false);
  }, [rows, runOne]);

  const done = rows.filter((r) => results[r.id] !== undefined);
  const green = done.filter((r) => results[r.id]?.passed === true).length;
  const busy = running !== null || all || resetting;
  const blocked = done.filter((r) => results[r.id]?.blocked === true).length;

  return (
    <section className="panel flex min-h-0 flex-1 flex-col">
      <div className="panel-head flex items-baseline justify-between px-4 py-3">
        <h2 className="display text-[15px] text-paper">Tested, not trusted</h2>
        <span className="eyebrow">
          {done.length === 0
            ? "nothing broken yet"
            : `${green}/${done.length - blocked} verified${blocked > 0 ? ` · ${blocked} blocked` : ""}`}
        </span>
      </div>

      <div className="border-b border-rule px-4 py-3">
        <p className="max-w-[78ch] text-[13px] leading-relaxed text-paper-dim">
          Eleven engineered failures. Each one injects a real fault — a lying agent, a declining
          card, a forged signature, a replayed token, a bounced receipt, a dead Slack, a process
          that dies after paying — then checks that the recovery happened, that the money never
          moved wrongly, and that the ledger recorded it. Nothing is simulated at the boundary:
          the webhook rows arrive as HTTP requests to this app&apos;s own Stripe endpoint.
          <span className="text-paper-faint"> The same table runs headless as <span className="figures">npm run eval</span>, with every bench scenario and the chain check.</span>
        </p>
        <div className="mt-3">
          <Bench bench={bench} onReset={() => void resetBench()} busy={busy} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void runAll()}
            disabled={busy}
            className="border border-vermilion bg-vermilion/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-vermilion transition-colors hover:bg-vermilion/20 disabled:opacity-40"
          >
            {all ? "Breaking things…" : "Run the whole table"}
          </button>
          <span className="text-[12px] text-paper-faint">
            F1–F11 in order, then the whole chain is re-verified.
          </span>
          {chain === null ? null : (
            <span className={`figures text-[12px] ${chain.ok ? "text-verdigris" : "text-vermilion"}`}>
              {chain.ok ? `chain intact · ${chain.count} entries` : "chain broken"}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((row) => (
          <Row
            key={row.id}
            row={row}
            result={results[row.id]}
            status={statusOf(row, results, running)}
            expanded={expanded === row.id}
            onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
            onRun={() => void runOne(row.id)}
            busy={busy}
          />
        ))}
      </div>
    </section>
  );
}
