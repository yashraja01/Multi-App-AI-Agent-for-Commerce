"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "./Header";
import { Authority } from "./merchant/Authority";
import { Earnings } from "./merchant/Earnings";
import { Instructions, type InstructionPatch } from "./merchant/Instructions";
import { OrdersPanel } from "./merchant/OrdersPanel";
import type { MerchantSummary, PolicyView, StateView } from "@/lib/types";

/**
 * The merchant's seat.
 *
 * Mission Control watches the gate decide. This owns the rules it decides by,
 * and the money those rules earned. Same system, same store, same ledger --
 * the difference is only whose question is being answered.
 *
 * No SSE here. Nothing on this page streams: a policy is a standing fact and a
 * revenue total is a sum over the chain, so snapshots on mount and after each
 * mutation are the honest transport.
 */

export function MerchantConsole() {
  const [state, setState] = useState<StateView | null>(null);
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [summary, setSummary] = useState<MerchantSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    const res = await fetch("/api/state", { cache: "no-store" });
    const next = (await res.json()) as StateView;
    setState(next);
    // First load picks whichever merchant the seed listed first.
    setMerchantId((prev) => prev ?? next.merchants[0]?.merchant_id ?? null);
  }, []);

  const refreshMerchant = useCallback(async (id: string) => {
    const [p, s] = await Promise.all([
      fetch(`/api/merchant/profile?merchant_id=${encodeURIComponent(id)}`, { cache: "no-store" }),
      fetch(`/api/merchant/summary?merchant_id=${encodeURIComponent(id)}`, { cache: "no-store" }),
    ]);
    if (p.ok) setPolicy((await p.json()) as PolicyView);
    if (s.ok) setSummary((await s.json()) as MerchantSummary);
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  useEffect(() => {
    if (merchantId !== null) void refreshMerchant(merchantId);
  }, [merchantId, refreshMerchant]);

  const save = useCallback(
    async (patch: InstructionPatch) => {
      if (merchantId === null) return;
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/merchant/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ merchant_id: merchantId, ...patch }),
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          setError(body.error ?? `Save failed (${res.status})`);
          return;
        }
        setPolicy((await res.json()) as PolicyView);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [merchantId],
  );

  const freeze = useCallback(
    async (frozen: boolean) => {
      setBusy(true);
      await fetch("/api/freeze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frozen }),
      });
      await refreshState();
      setBusy(false);
    },
    [refreshState],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    await fetch("/api/reset", { method: "POST" });
    await refreshState();
    if (merchantId !== null) await refreshMerchant(merchantId);
    setBusy(false);
  }, [refreshState, refreshMerchant, merchantId]);

  const merchants = state?.merchants ?? [];

  return (
    <div className="flex min-h-screen flex-col">
      <Header state={state} busy={busy} onFreeze={freeze} onReset={reset} current="merchant" />

      {/*
        * One column, read top to bottom: the answer, then the orders that make
        * it up, then what the agent is allowed to do next.
        *
        * Deliberately not the two-column instrument grid Mission Control uses.
        * The observer watches several things at once and needs density; the
        * merchant asks one question and then gives instructions, and a screen
        * that reads in one direction is the difference between the two seats.
        */}
      <main className="mx-auto w-full max-w-[1320px] flex-1 px-6 py-9 lg:px-10 lg:py-12">
        {/* One gate, two shops. Switching here changes only the data. */}
        {merchants.length > 1 && merchantId !== null ? (
          <div className="mb-8 flex flex-wrap items-center gap-6">
            {merchants.map((m) => (
              <button
                key={m.merchant_id}
                type="button"
                onClick={() => setMerchantId(m.merchant_id)}
                disabled={saving || busy}
                aria-pressed={m.merchant_id === merchantId}
                title={m.vertical}
                className={`figures border-b-2 pb-1 text-[12.5px] transition-colors disabled:opacity-40 ${
                  m.merchant_id === merchantId
                    ? "border-brass text-paper"
                    : "border-transparent text-paper-faint hover:text-paper-dim"
                }`}
              >
                {m.display_name}
              </button>
            ))}
          </div>
        ) : null}

        <Earnings summary={summary} />

        <div className="mt-12 border-t border-rule pt-9">
          <Instructions
            policy={policy}
            saving={saving}
            disabled={busy}
            onSave={(patch) => void save(patch)}
          />
        </div>

        {error === null ? (
          <p className="sr-only" role="status" />
        ) : (
          <p
            role="status"
            className="mt-4 border border-vermilion-dim bg-vermilion/10 px-3 py-2 text-[12px] text-vermilion"
          >
            {error}
          </p>
        )}

        <div className="mt-12 grid grid-cols-1 gap-x-12 gap-y-10 border-t border-rule pt-9 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <OrdersPanel orders={summary?.orders ?? []} />
          <Authority envelopes={state?.envelopes ?? []} />
        </div>
      </main>

      <footer className="border-t border-rule px-6 py-4 text-center text-[11px] text-paper-faint">
        You set the rule. The gate enforces it. Neither of you is the agent.
      </footer>
    </div>
  );
}
