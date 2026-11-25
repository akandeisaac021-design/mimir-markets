import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDeadlineAbstention,
  classifyVoteAttempt,
  evaluateQuorum,
  formatAgreementWithSampleSize,
  summarizeCouncilAgreement,
  type ClassifiedVote,
  type VoteAttemptInput,
} from "../../lib/council/quorum";
import {
  changedDecisions,
  runPolicyComparison,
  summarizePeerBallotAgreement,
  type CapturedBallot,
} from "../../agents/council/shared/peer-reasoning";

function attempt(
  partial: Partial<VoteAttemptInput> & Pick<VoteAttemptInput, "slug">,
): VoteAttemptInput {
  return {
    claimId: 42,
    expectedClaimId: 42,
    claimState: "active",
    status: "ok",
    verdict: "CREATOR_WINS",
    confidence: 80,
    ...partial,
  };
}

function valid(
  slug: string,
  verdict: "CREATOR_WINS" | "CHALLENGERS_WIN" | "DRAW" | "UNRESOLVABLE" = "CREATOR_WINS",
): ClassifiedVote {
  return classifyVoteAttempt(attempt({ slug, verdict }));
}

// ── lib/council/quorum.ts: summarizeCouncilAgreement ──────────────────────────

test("summarizeCouncilAgreement pairs agreement percentage with valid eligible sample size", () => {
  const attempts = [
    valid("optimist", "CREATOR_WINS"),
    valid("statistician", "CREATOR_WINS"),
    valid("contrarian", "CREATOR_WINS"),
    valid("doomer", "CHALLENGERS_WIN"),
  ];

  const summary = summarizeCouncilAgreement(attempts);
  assert.equal(summary.status, "measured");
  assert.equal(summary.sampleSize, 4);
  assert.equal(summary.agreeingVotes, 3);
  assert.equal(summary.agreementPct, 75);
  assert.equal(summary.verdict, "CREATOR_WINS");
  assert.equal(summary.totalAttempts, 4);
  assert.equal(summary.excludedCount, 0);
  assert.equal(summary.display, "75% (3/4, n=4)");
});

test("summarizeCouncilAgreement uses only valid eligible votes as the denominator", () => {
  const attempts: ClassifiedVote[] = [
    valid("optimist", "CREATOR_WINS"),
    valid("statistician", "CREATOR_WINS"),
    valid("doomer", "CHALLENGERS_WIN"),
    // Duplicate persona — must not inflate denominator
    valid("optimist", "CREATOR_WINS"),
    // Ineligible voter — valid vote, but outside eligibleVoteSet
    valid("rogue-juror", "CREATOR_WINS"),
    // Non-valid dispositions — must not inflate denominator
    classifyVoteAttempt(attempt({ slug: "bad", verdict: "UNKNOWN" })),
    classifyVoteAttempt(attempt({ slug: "old", claimId: 999 })),
    classifyVoteAttempt(attempt({ slug: "paused-one", personaPaused: true })),
    classifyVoteAttempt(attempt({ slug: "outage", status: "timeout" })),
    classifyDeadlineAbstention("late-juror"),
  ];

  const summary = summarizeCouncilAgreement(attempts, {
    eligibleVoteSet: ["optimist", "statistician", "doomer", "late-juror", "outage"],
  });

  assert.equal(summary.status, "measured");
  assert.equal(summary.sampleSize, 3);
  assert.equal(summary.agreeingVotes, 2);
  assert.equal(summary.agreementPct, 67);
  assert.equal(summary.verdict, "CREATOR_WINS");
  assert.equal(summary.totalAttempts, 10);
  assert.equal(summary.excludedCount, 7);
  assert.equal(summary.display, "67% (2/3, n=3)");
});

test("summarizeCouncilAgreement distinguishes an absent ballot from zero agreement", () => {
  // Absent ballot: empty attempts
  const empty = summarizeCouncilAgreement([]);
  assert.equal(empty.status, "absent_ballot");
  assert.equal(empty.sampleSize, 0);
  assert.equal(empty.agreeingVotes, 0);
  assert.equal(empty.agreementPct, null);
  assert.equal(empty.verdict, null);
  assert.equal(empty.display, "No ballot (n=0)");

  // Absent ballot: attempts exist, but none are valid eligible votes
  const allRejected = summarizeCouncilAgreement(
    [
      classifyVoteAttempt(attempt({ slug: "outage", status: "timeout" })),
      classifyVoteAttempt(attempt({ slug: "bad", verdict: "INVALID" })),
      classifyDeadlineAbstention("late"),
      valid("ineligible", "CREATOR_WINS"),
    ],
    { eligibleVoteSet: ["optimist", "doomer"] },
  );
  assert.equal(allRejected.status, "absent_ballot");
  assert.equal(allRejected.sampleSize, 0);
  assert.equal(allRejected.agreementPct, null);
  assert.equal(allRejected.totalAttempts, 4);
  assert.equal(allRejected.excludedCount, 4);
  assert.equal(allRejected.display, "No ballot (n=0)");

  // Zero agreement on a present ballot: valid eligible votes exist, none match target
  const zeroTarget = summarizeCouncilAgreement(
    [
      valid("optimist", "CHALLENGERS_WIN"),
      valid("doomer", "CHALLENGERS_WIN"),
      valid("statistician", "DRAW"),
    ],
    { targetVerdict: "CREATOR_WINS" },
  );
  assert.equal(zeroTarget.status, "measured");
  assert.equal(zeroTarget.sampleSize, 3);
  assert.equal(zeroTarget.agreeingVotes, 0);
  assert.equal(zeroTarget.agreementPct, 0);
  assert.equal(zeroTarget.verdict, "CREATOR_WINS");
  assert.equal(zeroTarget.display, "0% (0/3, n=3)");

  // Zero decisive agreement on a present ballot: all valid eligible votes are non-decisive
  const allNonDecisive = summarizeCouncilAgreement([
    valid("optimist", "DRAW"),
    valid("doomer", "UNRESOLVABLE"),
  ]);
  assert.equal(allNonDecisive.status, "measured");
  assert.equal(allNonDecisive.sampleSize, 2);
  assert.equal(allNonDecisive.agreeingVotes, 0);
  assert.equal(allNonDecisive.agreementPct, 0);
  assert.equal(allNonDecisive.verdict, null);
  assert.equal(allNonDecisive.display, "0% (0/2, n=2)");

  assert.notEqual(empty.display, zeroTarget.display);
  assert.notEqual(allRejected.agreementPct, allNonDecisive.agreementPct);
});

test("summarizeCouncilAgreement handles exact ties cleanly", () => {
  const tied = summarizeCouncilAgreement([
    valid("optimist", "CREATOR_WINS"),
    valid("statistician", "CREATOR_WINS"),
    valid("doomer", "CHALLENGERS_WIN"),
    valid("contrarian", "CHALLENGERS_WIN"),
  ]);

  assert.equal(tied.status, "measured");
  assert.equal(tied.sampleSize, 4);
  assert.equal(tied.agreeingVotes, 2);
  assert.equal(tied.agreementPct, 50);
  assert.equal(tied.verdict, null);
  assert.equal(tied.display, "50% (2/4, n=4)");
});

test("formatAgreementWithSampleSize formats measured, zero, and absent states", () => {
  assert.equal(
    formatAgreementWithSampleSize({
      status: "measured",
      agreementPct: 100,
      agreeingVotes: 3,
      sampleSize: 3,
    }),
    "100% (3/3, n=3)",
  );
  assert.equal(
    formatAgreementWithSampleSize({
      status: "measured",
      agreementPct: 0,
      agreeingVotes: 0,
      sampleSize: 3,
    }),
    "0% (0/3, n=3)",
  );
  assert.equal(
    formatAgreementWithSampleSize({
      status: "absent_ballot",
      agreementPct: null,
      agreeingVotes: 0,
      sampleSize: 0,
    }),
    "No ballot (n=0)",
  );
});

// ── lib/council/quorum.ts: evaluateQuorum integration ─────────────────────────

test("evaluateQuorum exposes sampleSize and agreement summary for use_council and fallback_solo", () => {
  const met = evaluateQuorum(
    [
      valid("optimist", "CREATOR_WINS"),
      valid("statistician", "CREATOR_WINS"),
      valid("doomer", "CHALLENGERS_WIN"),
      classifyVoteAttempt(attempt({ slug: "outage", status: "timeout" })),
    ],
    3,
  );
  assert.equal(met.action, "use_council");
  assert.equal(met.sampleSize, 3);
  assert.equal(met.agreement.status, "measured");
  assert.equal(met.agreement.agreementPct, 67);
  assert.equal(met.agreement.display, "67% (2/3, n=3)");
  assert.match(met.reason, /67% \(2\/3, n=3\)/);

  const absent = evaluateQuorum([], 3);
  assert.equal(absent.action, "fallback_solo");
  assert.equal(absent.sampleSize, 0);
  assert.equal(absent.agreement.status, "absent_ballot");
  assert.equal(absent.agreement.agreementPct, null);
  assert.equal(absent.agreement.display, "No ballot (n=0)");
  assert.match(absent.reason, /No ballot \(n=0\)/);

  const zeroAgreement = evaluateQuorum(
    [valid("optimist", "DRAW"), valid("doomer", "UNRESOLVABLE")],
    3,
  );
  assert.equal(zeroAgreement.action, "fallback_solo");
  assert.equal(zeroAgreement.sampleSize, 2);
  assert.equal(zeroAgreement.agreement.status, "measured");
  assert.equal(zeroAgreement.agreement.agreementPct, 0);
  assert.equal(zeroAgreement.agreement.display, "0% (0/2, n=2)");

  const cancelled = evaluateQuorum([valid("optimist", "CREATOR_WINS")], 1, {
    claimState: "cancelled",
  });
  assert.equal(cancelled.action, "abort_cancelled");
  assert.equal(cancelled.sampleSize, 0);
  assert.equal(cancelled.agreement.status, "absent_ballot");
  assert.equal(cancelled.agreement.agreementPct, null);
});

// ── agents/council/shared/peer-reasoning.ts ───────────────────────────────────

test("summarizePeerBallotAgreement uses valid eligible votes and distinguishes absent vs zero", () => {
  const ballots: CapturedBallot[] = [
    { persona: "optimist", verdict: "yes", confidence: 90 },
    { persona: "statistician", verdict: "yes", confidence: 80 },
    { persona: "doomer", verdict: "no", confidence: 70 },
    // Duplicate persona — excluded
    { persona: "optimist", verdict: "yes", confidence: 95 },
    // Below minConfidence — excluded
    { persona: "contrarian", verdict: "no", confidence: 40 },
    // Ineligible persona — excluded
    { persona: "outsider", verdict: "yes", confidence: 99 },
    // Malformed confidence — excluded
    { persona: "broken", verdict: "yes", confidence: Number.NaN },
  ];

  const summary = summarizePeerBallotAgreement(ballots, {
    eligiblePersonas: ["optimist", "statistician", "doomer", "contrarian", "broken"],
    minConfidence: 60,
  });

  assert.equal(summary.status, "measured");
  assert.equal(summary.sampleSize, 3);
  assert.equal(summary.agreeingVotes, 2);
  assert.equal(summary.agreementPct, 67);
  assert.equal(summary.verdict, "yes");
  assert.equal(summary.totalAttempts, 7);
  assert.equal(summary.excludedCount, 4);
  assert.equal(summary.display, "67% (2/3, n=3)");

  // Absent ballot
  const absent = summarizePeerBallotAgreement([], { minConfidence: 50 });
  assert.equal(absent.status, "absent_ballot");
  assert.equal(absent.sampleSize, 0);
  assert.equal(absent.agreementPct, null);
  assert.equal(absent.display, "No ballot (n=0)");

  // Zero agreement on present ballot (all valid eligible votes abstained)
  const zeroAbstain = summarizePeerBallotAgreement(
    [
      { persona: "optimist", verdict: "abstain", confidence: 80 },
      { persona: "doomer", verdict: "abstain", confidence: 75 },
    ],
    { minConfidence: 50 },
  );
  assert.equal(zeroAbstain.status, "measured");
  assert.equal(zeroAbstain.sampleSize, 2);
  assert.equal(zeroAbstain.agreeingVotes, 0);
  assert.equal(zeroAbstain.agreementPct, 0);
  assert.equal(zeroAbstain.display, "0% (0/2, n=2)");
});

test("runPolicyComparison exposes sampleSize and agreementDisplay while preserving decision compatibility", () => {
  const ballots: CapturedBallot[] = [
    { persona: "optimist", verdict: "yes", confidence: 85 },
    { persona: "statistician", verdict: "yes", confidence: 80 },
    { persona: "doomer", verdict: "no", confidence: 75 },
    { persona: "contrarian", verdict: "yes", confidence: 50 },
  ];

  const baseline = runPolicyComparison(ballots, [
    { name: "standard", quorum: 3, minConfidence: 60 },
    { name: "strict", quorum: 3, minConfidence: 95 },
  ]);

  assert.equal(baseline[0].decision, "yes");
  assert.equal(baseline[0].sampleSize, 3);
  assert.equal(baseline[0].agreementPct, 67);
  assert.equal(baseline[0].agreementDisplay, "67% (2/3, n=3)");

  // Strict minConfidence=95 filters out all ballots -> absent ballot, not 0%
  assert.equal(baseline[1].decision, "undecided");
  assert.equal(baseline[1].sampleSize, 0);
  assert.equal(baseline[1].agreementPct, null);
  assert.equal(baseline[1].agreementDisplay, "No ballot (n=0)");

  const candidate = runPolicyComparison(ballots, [
    { name: "standard", quorum: 3, minConfidence: 60 },
    { name: "strict", quorum: 3, minConfidence: 50 },
  ]);
  assert.equal(candidate[1].decision, "yes");
  assert.equal(candidate[1].sampleSize, 4);
  assert.equal(candidate[1].agreementPct, 75);
  assert.equal(candidate[1].agreementDisplay, "75% (3/4, n=4)");

  const diff = changedDecisions(baseline, candidate);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].policy, "strict");
});
