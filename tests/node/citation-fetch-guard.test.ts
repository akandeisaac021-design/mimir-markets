import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResearchCitations,
  isCitationScopeCurrent,
  type ResearchCitationInput,
} from "../../lib/research/citations";
import { createCitationFetchGuard, isAbortError } from "../../lib/research/citation-fetch-guard";

const NOW = 1_700_000_000_000;

function source(url: string): ResearchCitationInput {
  return {
    url,
    trustTier: "primary",
    contentHash: "aa".repeat(32),
    excerpt: "synthetic fixture",
    capturedAt: NOW - 60_000,
  };
}

/** A fake transport: each call returns a promise the test settles by hand. */
function fakeTransport() {
  const pending: Array<{
    url: string;
    signal: AbortSignal;
    resolve: (items: ResearchCitationInput[]) => void;
  }> = [];
  function fetchCitations(url: string, signal: AbortSignal): Promise<ResearchCitationInput[]> {
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
      pending.push({ url, signal, resolve });
    });
  }
  return { pending, fetchCitations };
}

test("isCitationScopeCurrent matches market id and source revision", () => {
  assert.equal(isCitationScopeCurrent({ marketId: 7 }, { marketId: 7 }), true);
  assert.equal(isCitationScopeCurrent({ marketId: 7 }, { marketId: "7" }), true);
  assert.equal(isCitationScopeCurrent({ marketId: 7 }, { marketId: 8 }), false);
  assert.equal(
    isCitationScopeCurrent({ marketId: 7, revision: "r2" }, { marketId: 7, revision: "r1" }),
    false,
  );
  assert.equal(
    isCitationScopeCurrent({ marketId: 7, revision: "r2" }, { marketId: 7, revision: "r2" }),
    true,
  );
  // Legacy callers that pass no result scope keep the unbound behavior.
  assert.equal(isCitationScopeCurrent({ marketId: 7 }, null), true);
  assert.equal(isCitationScopeCurrent(undefined, undefined), true);
  // A bound result with nothing selected is never current.
  assert.equal(isCitationScopeCurrent(null, { marketId: 7 }), false);
});

test("buildResearchCitations hides rows fetched for another market", () => {
  const view = buildResearchCitations({
    sources: [source("https://market-a.example/report")],
    nowMs: NOW,
    currentScope: { marketId: 2 },
    resultScope: { marketId: 1 },
  });
  assert.equal(view.status, "cancelled");
  assert.deepEqual(view.citations, []);
  assert.deepEqual(view.displayable, []);
});

test("buildResearchCitations hides rows from an older source revision", () => {
  const view = buildResearchCitations({
    sources: [source("https://market-a.example/report")],
    nowMs: NOW,
    currentScope: { marketId: 1, revision: "pack-2" },
    resultScope: { marketId: 1, revision: "pack-1" },
  });
  assert.equal(view.status, "cancelled");
  assert.equal(view.displayable.length, 0);
});

test("buildResearchCitations keeps rows bound to the current market", () => {
  const view = buildResearchCitations({
    sources: [source("https://market-a.example/report")],
    nowMs: NOW,
    currentScope: { marketId: 1, revision: "pack-1" },
    resultScope: { marketId: 1, revision: "pack-1" },
  });
  assert.equal(view.status, "ready");
  assert.equal(view.displayable.length, 1);
});

test("buildResearchCitations without scopes is unchanged", () => {
  const unbound = buildResearchCitations({
    sources: [source("https://market-a.example/report")],
    nowMs: NOW,
  });
  assert.equal(unbound.status, "ready");
  assert.equal(unbound.displayable.length, 1);
});

test("a late response for the previous market is dropped after a switch", async () => {
  // Before: market A's slow response landed after the user picked market B and
  // replaced B's evidence. After: A's ticket is no longer current.
  const guard = createCitationFetchGuard();
  const transport = fakeTransport();
  const shown: Array<{ marketId: string | number; urls: string[] }> = [];

  async function load(marketId: number) {
    const ticket = guard.begin({ marketId });
    try {
      const items = await transport.fetchCitations(`/api/vs/${marketId}/reasoning`, ticket.signal);
      if (!ticket.isCurrent()) return "stale";
      shown.push({ marketId, urls: items.map((item) => item.url ?? "") });
      return "applied";
    } catch (error) {
      if (isAbortError(error)) return "aborted";
      throw error;
    }
  }

  const first = load(1);
  const second = load(2);
  assert.equal(transport.pending.length, 2);
  assert.equal(transport.pending[0]?.signal.aborted, true, "switching aborts market 1's request");

  transport.pending[1]?.resolve([source("https://market-b.example/report")]);
  // Market 1 resolving late (a transport that ignores abort) must still be ignored.
  transport.pending[0]?.resolve([source("https://market-a.example/report")]);

  assert.equal(await first, "aborted");
  assert.equal(await second, "applied");
  assert.deepEqual(shown, [{ marketId: 2, urls: ["https://market-b.example/report"] }]);
});

test("a ticket from before a source revision change is not current", () => {
  const guard = createCitationFetchGuard();
  const older = guard.begin({ marketId: 1, revision: "pack-1" });
  const newer = guard.begin({ marketId: 1, revision: "pack-2" });
  assert.equal(older.isCurrent(), false);
  assert.equal(older.signal.aborted, true);
  assert.equal(newer.isCurrent(), true);
});

test("dispose invalidates the in-flight ticket (unmount)", () => {
  const guard = createCitationFetchGuard();
  const ticket = guard.begin({ marketId: 1 });
  assert.equal(ticket.isCurrent(), true);
  guard.dispose();
  assert.equal(ticket.isCurrent(), false);
  assert.equal(ticket.signal.aborted, true);
});

test("isAbortError only matches abort rejections", () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(isAbortError(abort), true);
  assert.equal(isAbortError(new Error("network down")), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError("AbortError"), false);
});
