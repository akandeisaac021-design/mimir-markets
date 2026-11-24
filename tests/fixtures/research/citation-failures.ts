/**
 * Deterministic citation-failure fixtures (issues #936 and #937).
 *
 * Each case is a source the producer can actually hand the panel (unsafe URL,
 * withdrawn source, stale capture, malformed digest, duplicate) plus the status
 * the citation row must render. No clock reads: `CITATION_NOW_MS` is fixed.
 */

import type {
  CitationRowStatus,
  ResearchCitationInput,
} from "../../../lib/research/citations";

export const CITATION_NOW_MS = 1_700_000_000_000;

export const CITATION_PRIMARY_HASH = "aa".repeat(32);
export const CITATION_CORROB_HASH = "bb".repeat(32);
export const CITATION_SECONDARY_HASH = "cc".repeat(32);

export type CitationFailureCase = {
  name: string;
  source: ResearchCitationInput;
  /** `null` means the row is displayable with this status. */
  expectedStatus: CitationRowStatus | "dropped";
  expectedDisplayable: boolean;
};

/** Deadline used by the stale case: the capture is 10 seconds past it. */
export const CITATION_DEADLINE_UNIX = Math.floor(CITATION_NOW_MS / 1000) - 10;

export const CITATION_FAILURE_CASES: readonly CitationFailureCase[] = [
  {
    name: "javascript URL is invalid and not clickable",
    source: {
      url: "javascript:alert(1)",
      trustTier: "primary",
      contentHash: CITATION_PRIMARY_HASH,
      capturedAt: CITATION_NOW_MS - 60_000,
    },
    expectedStatus: "invalid",
    expectedDisplayable: false,
  },
  {
    name: "producer withdrew the source",
    source: {
      url: "https://withdrawn.example/report",
      trustTier: "primary",
      contentHash: CITATION_PRIMARY_HASH,
      capturedAt: CITATION_NOW_MS - 60_000,
      cancelled: true,
    },
    expectedStatus: "cancelled",
    expectedDisplayable: false,
  },
  {
    name: "capture after the claim deadline is stale but still linked",
    source: {
      url: "https://late.example/report",
      trustTier: "primary",
      contentHash: CITATION_PRIMARY_HASH,
      capturedAt: CITATION_NOW_MS,
    },
    expectedStatus: "stale",
    expectedDisplayable: true,
  },
  {
    name: "malformed digest is a dependency failure",
    source: {
      url: "https://broken-digest.example/report",
      trustTier: "corroborating",
      contentHash: "not-a-32-byte-digest",
      capturedAt: CITATION_NOW_MS - 60_000,
    },
    expectedStatus: "dependency_failure",
    expectedDisplayable: true,
  },
  {
    name: "duplicate content digest collapses into the kept row",
    source: {
      url: "https://mirror.example/copy",
      trustTier: "corroborating",
      contentHash: CITATION_PRIMARY_HASH,
      capturedAt: CITATION_NOW_MS - 60_000,
    },
    expectedStatus: "duplicated",
    expectedDisplayable: false,
  },
];

/** Two dated sources plus one undated source for the ordering cases. */
export const CITATION_ORDERING_SOURCES: readonly ResearchCitationInput[] = [
  {
    url: "https://b.example/report",
    trustTier: "corroborating",
    contentHash: CITATION_CORROB_HASH,
    capturedAt: CITATION_NOW_MS - 60_000,
  },
  {
    url: "https://a.example/report",
    trustTier: "corroborating",
    contentHash: CITATION_SECONDARY_HASH,
    capturedAt: CITATION_NOW_MS - 60_000,
  },
  {
    url: "https://newest.example/report",
    trustTier: "corroborating",
    contentHash: CITATION_PRIMARY_HASH,
    capturedAt: CITATION_NOW_MS - 1_000,
  },
  {
    url: "https://undated.example/report",
    trustTier: "corroborating",
    contentHash: "dd".repeat(32),
    capturedAt: null,
  },
];
