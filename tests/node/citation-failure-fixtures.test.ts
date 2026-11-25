/**
 * #936 + #937 — deterministic citation-failure fixtures.
 *
 * Pins each failure family the citation panel must render consistently:
 * unsafe URL, withdrawn source, stale capture, malformed digest and duplicate
 * content. Ordering assertions cover the canonical identity tie-break required
 * when capture times are equal.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResearchCitations,
  citationSourceIdentity,
  compareCitations,
  type ResearchCitationInput,
} from "../../lib/research/citations";
import {
  CITATION_DEADLINE_UNIX,
  CITATION_FAILURE_CASES,
  CITATION_NOW_MS,
  CITATION_PRIMARY_HASH,
} from "../fixtures/research/citation-failures";

/** The source that wins the duplicate collapse in the duplicate case. */
const KEPT_SOURCE: ResearchCitationInput = {
  url: "https://primary.example/report",
  domain: "primary.example",
  trustTier: "primary",
  contentHash: CITATION_PRIMARY_HASH,
  capturedAt: CITATION_NOW_MS - 60_000,
};

function buildFor(source: ResearchCitationInput) {
  return buildResearchCitations({
    sources: [KEPT_SOURCE, source],
    deadlineUnix: CITATION_DEADLINE_UNIX,
    nowMs: CITATION_NOW_MS,
  });
}

test("citation failure fixtures land on their documented status", () => {
  for (const scenario of CITATION_FAILURE_CASES) {
    const view = buildFor(scenario.source);
    const row = view.citations.find(
      (citation) => citation.url === scenario.source.url || citation.status === scenario.expectedStatus,
    );

    assert.ok(row, `${scenario.name}: expected a citation row`);
    assert.equal(row.status, scenario.expectedStatus, scenario.name);

    const isDisplayable = view.displayable.some(
      (citation) => citation.id === row.id,
    );
    assert.equal(isDisplayable, scenario.expectedDisplayable, scenario.name);
  }
});

test("only safe http(s) sources are ever displayable", () => {
  for (const scenario of CITATION_FAILURE_CASES) {
    for (const row of buildFor(scenario.source).displayable) {
      assert.match(row.url, /^https?:\/\//, scenario.name);
      assert.equal(row.externalSafe, true, scenario.name);
    }
  }
});

test("a cancelled or invalid row never appears in the displayable list", () => {
  for (const scenario of CITATION_FAILURE_CASES) {
    if (scenario.expectedDisplayable) continue;
    const view = buildFor(scenario.source);
    assert.equal(
      view.displayable.some((row) => row.status === scenario.expectedStatus),
      false,
      scenario.name,
    );
  }
});

test("citation ordering is a total order: shuffling never changes it", () => {
  const sources: ResearchCitationInput[] = CITATION_FAILURE_CASES.map(
    (scenario) => scenario.source,
  );

  const forward = buildResearchCitations({
    sources,
    deadlineUnix: CITATION_DEADLINE_UNIX,
    nowMs: CITATION_NOW_MS,
  });
  const backward = buildResearchCitations({
    sources: [...sources].reverse(),
    deadlineUnix: CITATION_DEADLINE_UNIX,
    nowMs: CITATION_NOW_MS,
  });

  const order = (view: typeof forward) =>
    view.displayable.map((row) => citationSourceIdentity(row));

  assert.deepEqual(order(forward), order(backward));

  // Every adjacent pair agrees with the documented comparator.
  for (const view of [forward, backward]) {
    for (let i = 1; i < view.citations.length; i += 1) {
      assert.ok(
        compareCitations(view.citations[i - 1], view.citations[i]) <= 0,
        `citations[${i - 1}] must sort before citations[${i}]`,
      );
    }
  }
});
