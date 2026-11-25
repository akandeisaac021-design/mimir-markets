/**
 * Guards citation / evidence fetches against market switches.
 *
 * A market view fetches its evidence asynchronously. When the user selects a
 * different market (or the market's sources are revised) before that fetch
 * settles, the late response must not be applied: it would show one market's
 * evidence under another market's header. Each `begin()` aborts the previous
 * request and hands back a ticket whose `isCurrent()` turns false as soon as a
 * newer request starts or the guard is disposed.
 *
 * Pure apart from `AbortController` — safe for node tests and SSR.
 */

import { isCitationScopeCurrent, type CitationScope } from "@/lib/research/citations";

export interface CitationFetchTicket {
  /** The market and source revision this request was started for. */
  readonly scope: CitationScope;
  /** Pass to `fetch` so a superseded request stops downloading. */
  readonly signal: AbortSignal;
  /** False once a newer request started, the scope moved, or the guard was disposed. */
  isCurrent(): boolean;
}

export interface CitationFetchGuard {
  /** Start a request for `scope`, aborting whichever request was in flight. */
  begin(scope: CitationScope): CitationFetchTicket;
  /** Abort the in-flight request and invalidate every ticket (component unmount). */
  dispose(): void;
}

export function createCitationFetchGuard(): CitationFetchGuard {
  let generation = 0;
  let controller: AbortController | null = null;
  let currentScope: CitationScope | null = null;

  return {
    begin(scope) {
      controller?.abort();
      const own = new AbortController();
      controller = own;
      currentScope = scope;
      const ticketGeneration = ++generation;
      return {
        scope,
        signal: own.signal,
        isCurrent: () =>
          ticketGeneration === generation &&
          !own.signal.aborted &&
          isCitationScopeCurrent(currentScope, scope),
      };
    },
    dispose() {
      generation++;
      controller?.abort();
      controller = null;
      currentScope = null;
    },
  };
}

/** True for the rejection `fetch` raises when its signal is aborted. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
