import "server-only";
import type { BusEvent, TheatreEvent } from "./types";

/**
 * The run bus.
 *
 * A run started from a button streams its events back on the same request.
 * A run started by an *email* has no request to stream back on -- the trigger
 * came from Gmail, not a browser -- so its events go here, and any open
 * Mission Control tab reads them from `/api/events`.
 *
 * In-memory, bounded, process-local. This is a live feed, not a record: the
 * record is the ledger, and nothing here is ever the only copy of anything.
 */

export type { BusEvent };

type Listener = (e: BusEvent) => void;

const KEEP = 500;

class RunBus {
  #seq = 0;
  readonly #ring: BusEvent[] = [];
  readonly #listeners = new Set<Listener>();

  publish(run_id: string, source: BusEvent["source"], event: TheatreEvent): BusEvent {
    this.#seq += 1;
    const e: BusEvent = { seq: this.#seq, ts: new Date().toISOString(), run_id, source, event };
    this.#ring.push(e);
    if (this.#ring.length > KEEP) this.#ring.splice(0, this.#ring.length - KEEP);
    for (const l of this.#listeners) l(e);
    return e;
  }

  /** Everything after `since`, oldest first. */
  since(seq: number): BusEvent[] {
    return this.#ring.filter((e) => e.seq > seq);
  }

  subscribe(l: Listener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  get seq(): number {
    return this.#seq;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __mercury_bus__: RunBus | undefined;
}

export function bus(): RunBus {
  globalThis.__mercury_bus__ ??= new RunBus();
  return globalThis.__mercury_bus__;
}
