"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AcrossApps, type Drills } from "./AcrossApps";
import { ChaosPanel } from "./ChaosPanel";
import { GatePanel } from "./GatePanel";
import { Header } from "./Header";
import { LedgerPanel, type VerifyState } from "./LedgerPanel";
import { Theatre } from "./Theatre";
import { TabStrip } from "./ui/TabStrip";
import type { BusEvent, LedgerEntry, StateView, TheatreEvent } from "@/lib/types";

/**
 * The board.
 *
 * Holds the only mutable state in the UI: the event stream from the current
 * run, and the last snapshot of the server. Everything else is derived. The
 * three panels are spectators on the same run and never talk to each other.
 */

export function MissionControl({ llmAvailable }: { llmAvailable: boolean }) {
  const [state, setState] = useState<StateView | null>(null);
  const [events, setEvents] = useState<TheatreEvent[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [selected, setSelected] = useState("topup");
  const [view, setView] = useState<"theatre" | "chaos">("theatre");
  const [mode, setMode] = useState<"scripted" | "llm">("scripted");
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState<VerifyState | null>(null);
  const [verifying, setVerifying] = useState(false);
  /** The email-started run being shown on the strip, as bus frames. */
  const [emailRun, setEmailRun] = useState<BusEvent[]>([]);
  const [sending, setSending] = useState(false);
  const emailRunId = useRef<string | null>(null);

  const refreshState = useCallback(async () => {
    const res = await fetch("/api/state", { cache: "no-store" });
    setState((await res.json()) as StateView);
  }, []);

  const refreshLedger = useCallback(async () => {
    const res = await fetch("/api/ledger?limit=80", { cache: "no-store" });
    const body = (await res.json()) as { entries: LedgerEntry[] };
    setLedger(body.entries);
  }, []);

  useEffect(() => {
    void refreshState();
    void refreshLedger();
  }, [refreshState, refreshLedger]);

  /*
   * The run bus. A run an email started has no request of ours to stream on,
   * so we listen here. Its events go to the strip *and* to the theatre -- the
   * strip is the summary, the theatre is the narration -- and a new run id
   * starts both afresh.
   */
  useEffect(() => {
    const es = new EventSource("/api/events?since=0");
    es.onmessage = (msg) => {
      const frame = JSON.parse(msg.data as string) as BusEvent;
      if (frame.source !== "email") return;
      if (emailRunId.current !== frame.run_id) {
        emailRunId.current = frame.run_id;
        setEmailRun([frame]);
        setEvents([frame.event]);
        setVerify(null);
      } else {
        setEmailRun((prev) => [...prev, frame]);
        setEvents((prev) => [...prev, frame.event]);
      }
      if (frame.event.type === "done" || frame.event.type === "app") {
        void refreshState();
        void refreshLedger();
      }
    };
    return () => es.close();
  }, [refreshState, refreshLedger]);

  const send = useCallback(
    async (email: { from: string; subject: string; text: string }, drills: Drills) => {
      setSending(true);
      setView("theatre");
      try {
        await fetch("/api/intake/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...email, mode, ...drills }),
        });
      } finally {
        setSending(false);
        await refreshState();
        await refreshLedger();
      }
    },
    [mode, refreshState, refreshLedger],
  );

  const restart = useCallback(async () => {
    setSending(true);
    try {
      await fetch("/api/ops/outbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release" }),
      });
    } finally {
      setSending(false);
      await refreshState();
      await refreshLedger();
    }
  }, [refreshState, refreshLedger]);

  /** Read the SSE body frame by frame and append each event as it lands. */
  const run = useCallback(async () => {
    setRunning(true);
    setEvents([]);
    setVerify(null);

    try {
      const res = await fetch("/api/negotiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: selected, mode }),
      });
      if (res.body === null) throw new Error("no stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line === undefined) continue;
          const payload = line.slice(6);
          if (payload === "{}") continue;
          setEvents((prev) => [...prev, JSON.parse(payload) as TheatreEvent]);
        }
      }
    } catch (e) {
      setEvents((prev) => [...prev, { type: "note", text: `Run failed: ${(e as Error).message}` }]);
    } finally {
      setRunning(false);
      await refreshState();
      await refreshLedger();
    }
  }, [selected, mode, refreshState, refreshLedger]);

  const freeze = useCallback(
    async (frozen: boolean) => {
      setBusy(true);
      await fetch("/api/freeze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frozen }),
      });
      await refreshState();
      await refreshLedger();
      setBusy(false);
    },
    [refreshState, refreshLedger],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    setEvents([]);
    setEmailRun([]);
    emailRunId.current = null;
    setVerify(null);
    await fetch("/api/reset", { method: "POST" });
    await refreshState();
    await refreshLedger();
    setBusy(false);
  }, [refreshState, refreshLedger]);

  const runVerify = useCallback(async () => {
    setVerifying(true);
    const res = await fetch("/api/verify", { method: "POST" });
    setVerify((await res.json()) as VerifyState);
    setVerifying(false);
  }, []);

  // The gate panel always shows the most recent verdict of the current run.
  const lastVerdict =
    [...events].reverse().find((e): e is Extract<TheatreEvent, { type: "verdict" }> =>
      e.type === "verdict",
    ) ?? null;

  return (
    <div className="flex min-h-screen flex-col">
      <Header state={state} busy={busy} onFreeze={freeze} onReset={reset} current="mission" />

      {/*
        * One line saying what this screen is, before any panel.
        *
        * Someone seeing a demo has to place three unfamiliar things at once --
        * two agents and a gate. Naming the job of the screen costs one line and
        * saves the presenter a paragraph.
        */}
      <div className="mx-auto w-full max-w-[1680px] px-4 pt-5 lg:px-6">
        <p className="display text-[19px] leading-snug text-paper">
          Email the agent what the business needs. It haggles, pays and books the delivery —{" "}
          <span className="text-brass">and a gate, not the AI, decides whether any money may move.</span>
        </p>
        <p className="mt-1.5 max-w-[92ch] text-[13px] leading-relaxed text-paper-faint">
          Send the email and watch the run cross five apps. Underneath, the same run
          narrated turn by turn; on the right, the gate with the price it computed for
          itself, and the ledger that makes the whole thing checkable afterwards.
        </p>
      </div>

      <div className="mx-auto w-full max-w-[1680px] px-4 pt-4 lg:px-6">
        <AcrossApps
          state={state}
          run={emailRun}
          running={sending || running}
          mode={mode}
          onSend={(email, drills) => void send(email, drills)}
          onRestart={() => void restart()}
        />
      </div>

      <main className="mx-auto grid w-full max-w-[1680px] flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:p-6">
        <div className="flex min-h-[560px] flex-col gap-2 lg:h-[720px]">
          {/* Two ways to watch the same gate: one run narrated, or the whole
              failure table exercised at once. */}
          <TabStrip
            className="self-start"
            value={view}
            onChange={setView}
            disabled={running}
            tabs={[
              { id: "theatre", label: "One purchase" },
              { id: "chaos", label: "What happens when it goes wrong" },
            ]}
          />

          {view === "chaos" ? (
            <ChaosPanel
              onSettled={async () => {
                await refreshState();
                await refreshLedger();
              }}
            />
          ) : (
          <Theatre
            scenarios={state?.scenarios ?? []}
            selected={selected}
            onSelect={setSelected}
            mode={mode}
            onMode={setMode}
            llmAvailable={llmAvailable}
            events={events}
            running={running}
            onRun={() => void run()}
          />
          )}
        </div>

        <div className="grid min-h-0 grid-rows-[minmax(300px,auto)_minmax(300px,auto)] gap-4 lg:h-[720px] lg:grid-rows-[1.15fr_1fr]">
          <GatePanel verdict={lastVerdict} />
          <LedgerPanel
            entries={ledger}
            count={state?.ledger_count ?? 0}
            tip={state?.tip ?? ""}
            verify={verify}
            verifying={verifying}
            onVerify={() => void runVerify()}
          />
        </div>
      </main>

      <footer className="border-t border-rule px-6 py-3 text-center text-[11px] text-paper-faint">
        The agent proposes · the gate decides · Stripe settles · the ledger proves it
      </footer>
    </div>
  );
}
