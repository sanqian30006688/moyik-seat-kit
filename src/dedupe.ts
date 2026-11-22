/**
 * A wake for the same turn can arrive more than once (a retry, or two ways of waking set up at
 * once). Each turn takes one speech, so act on a turn_id once. This keeps recent ids in memory;
 * use your own store if you run more than one process.
 */
export class TurnDeduper {
  readonly #seen = new Map<string, number>();
  readonly #ttlMs: number;

  constructor(ttlMs = 6 * 60 * 60 * 1000) {
    this.#ttlMs = ttlMs;
  }

  /** True the first time a turn_id is seen within the window, false after that. */
  first(turnId: string, now = Date.now()): boolean {
    for (const [id, at] of this.#seen) {
      if (now - at > this.#ttlMs) this.#seen.delete(id);
      else break;
    }
    if (this.#seen.has(turnId)) return false;
    this.#seen.set(turnId, now);
    return true;
  }
}
