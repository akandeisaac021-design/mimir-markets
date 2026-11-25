/**
 * tests/node/challenge-ux-fixtures.test.ts
 *
 * Deterministic offline coverage for challenge UX under late and conflicting
 * observations, stale market revisions, wallet rejections, and uncertain
 * submissions. Runs without live wallets, funded accounts, or network access.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import CreateChallengeTicket, {
  computeChallengeTicketRevision,
} from "../../components/vs/CreateChallengeTicket";
import {
  buildChallengeRevisionKey,
  isChallengeIntentReviewValid,
} from "../../hooks/useVsDetail";
import {
  CHALLENGE_RECOVERY_MAX_AGE_MS,
  CHALLENGE_RECOVERY_MAX_STATUS_CHECKS,
  isChallengeRecoveryBlocking,
} from "../../lib/challenge-recovery";
import {
  DEFAULT_CHALLENGE_LOCK_SECONDS,
  MARKET_EXPIRY_CLOCK_SKEW_TOLERANCE_MS,
  MARKET_EXPIRY_MAX_OBSERVATION_AGE_MS,
} from "../../lib/market-expiry";
import {
  CHALLENGE_UX_BASE_NOW_MS,
  CHALLENGE_UX_TX_HASH_1,
  CHALLENGE_UX_TX_HASH_2,
  CHALLENGE_UX_WALLET_A,
  CHALLENGE_UX_WALLET_B,
  ChallengeUxFixtureHarness,
  makeChallengeFixtureVs,
  makeFixtureFreshness,
} from "./challenge-ux-fixtures";

const EN_MESSAGES = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "messages/en.json"), "utf8"),
) as Record<string, unknown>;

function renderTicketHtml(props: {
  accountChanged: boolean;
  walletAddress: string | null;
  stakeAmount?: number;
  settlementPreview?: string;
}): string {
  return renderToStaticMarkup(
    React.createElement(
      NextIntlClientProvider,
      { locale: "en", timeZone: "UTC", messages: EN_MESSAGES },
      React.createElement(CreateChallengeTicket, {
        draftId: "draft-ux-1",
        marketTypeLabel: "Binary",
        oddsModeLabel: "Pool",
        formatLabel: "Live",
        visibilityLabel: "Public",
        settlementPreview:
          props.settlementPreview ?? "Resolves YES if BTC closes above $100,000.",
        stakeAmount: props.stakeAmount ?? 5,
        walletAddress: props.walletAddress,
        accountChanged: props.accountChanged,
      }),
    ),
  );
}

// ── Late observations ─────────────────────────────────────────────────────────

test("late observation: superseded generation response cannot clobber fresher snapshot", () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    const gen1 = harness.beginFetch();
    const gen2 = harness.beginFetch({ isManual: true });

    const freshVs = makeChallengeFixtureVs({
      claim_statement: "Fresh on-chain statement v2",
      stake_amount: 10,
    });
    const freshCache = makeFixtureFreshness({
      source: "contract",
      status: "live",
      nowMs: harness.getNowMs(),
      ageMs: 0,
    });

    const appliedFresh = harness.deliverObservation(gen2, {
      vs: freshVs,
      cache: freshCache,
    });
    assert.equal(appliedFresh.applied, true);
    assert.equal(harness.getDetailState().vs?.question, "Fresh on-chain statement v2");
    assert.equal(harness.getDetailState().challengeStake, "10");

    // Late response from gen1 arrives with older statement and stake_amount.
    const lateVs = makeChallengeFixtureVs({
      claim_statement: "Stale statement v1",
      stake_amount: 2,
    });
    const lateRes = harness.deliverObservation(gen1, {
      vs: lateVs,
      cache: makeFixtureFreshness({
        source: "index",
        status: "cached",
        nowMs: harness.getNowMs(),
        ageMs: 12_000,
      }),
    });
    assert.equal(lateRes.applied, false);
    assert.equal(harness.getDetailState().vs?.question, "Fresh on-chain statement v2");
    assert.equal(harness.getDetailState().challengeStake, "10");
  } finally {
    harness.close();
  }
});

test("late observation: superseded fetch error does not increment attempts or clobber ready state", () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    const gen1 = harness.beginFetch();
    harness.refreshFromContract();
    assert.equal(harness.getDetailState().phase, "ready");
    assert.equal(harness.getDetailState().fetchAttempts, 0);

    const lateErr = harness.deliverFetchError(gen1);
    assert.equal(lateErr.applied, false);
    assert.equal(harness.getDetailState().phase, "ready");
    assert.equal(harness.getDetailState().fetchAttempts, 0);
  } finally {
    harness.close();
  }
});

test("late observation: user-entered integer USDC stake survives background refreshes", () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    harness.refreshFromContract();
    harness.setStake("25");

    const gen = harness.beginFetch();
    harness.deliverObservation(gen, {
      vs: makeChallengeFixtureVs({ stake_amount: 5 }),
      cache: makeFixtureFreshness({
        source: "contract",
        status: "live",
        nowMs: harness.getNowMs(),
      }),
    });

    assert.equal(harness.getDetailState().challengeStake, "25");
    assert.equal(harness.currentStakeUsdc(), 25);
  } finally {
    harness.close();
  }
});

// ── Conflicting observations (index vs authoritative Soroban contract) ────────

test("conflicting observation: stale read index blocks challengeability until contract read lands", async () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    const genIndex = harness.beginFetch();
    harness.deliverObservation(genIndex, {
      vs: harness.transport.getAuthoritativeVs(),
      cache: makeFixtureFreshness({
        source: "index",
        status: "stale",
        nowMs: harness.getNowMs(),
        ageMs: 90_000,
      }),
    });
    harness.captureReview();

    const blocked = await harness.submitChallenge();
    assert.equal(blocked.status, "refused");
    if (blocked.status === "refused") {
      assert.equal(blocked.reason, "observation_not_challengeable");
      assert.equal(blocked.expiry?.staleReason, "index_stale");
      assert.equal(blocked.expiry?.challengeable, false);
    }
    assert.equal(harness.wallet.attempts(), 0);

    // Authoritative Soroban contract read resolves the conflict and enables staking.
    harness.refreshFromContract();
    assert.equal(harness.evaluateExpiry().challengeable, true);
    const ok = await harness.submitChallenge();
    assert.equal(ok.status, "confirmed");
    assert.equal(harness.wallet.attempts(), 1);
  } finally {
    harness.close();
  }
});

test("conflicting observation: authoritative resolved state overrides earlier open index read", async () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    harness.refreshFromContract();
    harness.captureReview();
    assert.equal(harness.evaluateExpiry().challengeable, true);

    // On-chain state advances to resolved before user clicks submit.
    harness.transport.setAuthoritativeVs({ state: "resolved" });
    harness.refreshFromContract();

    const res = await harness.submitChallenge();
    assert.equal(res.status, "refused");
    if (res.status === "refused") {
      assert.equal(res.reason, "observation_not_challengeable");
      assert.equal(res.expiry?.challengeable, false);
    }
    assert.equal(harness.wallet.attempts(), 0);
  } finally {
    harness.close();
  }
});

test("boundary: observation age, clock skew, and 60s challenge lock window", async () => {
  const deadlineSec = Math.floor(CHALLENGE_UX_BASE_NOW_MS / 1000) + 120;
  const harness = new ChallengeUxFixtureHarness({
    initialVs: makeChallengeFixtureVs({ deadline: deadlineSec }),
  });
  try {
    // Clock skew at exact tolerance (5_000ms) is still trusted; +1ms blocks.
    harness.refreshFromContract({ serverClockOffsetMs: MARKET_EXPIRY_CLOCK_SKEW_TOLERANCE_MS });
    assert.equal(harness.evaluateExpiry().challengeable, true);

    harness.refreshFromContract({ serverClockOffsetMs: MARKET_EXPIRY_CLOCK_SKEW_TOLERANCE_MS + 1 });
    assert.equal(harness.evaluateExpiry().staleReason, "clock_skew");
    assert.equal(harness.evaluateExpiry().challengeable, false);

    // Reset to zero skew, test observation age boundary (30_000ms vs 30_001ms).
    harness.refreshFromContract({ serverClockOffsetMs: 0 });
    harness.advanceClock(MARKET_EXPIRY_MAX_OBSERVATION_AGE_MS);
    assert.equal(harness.evaluateExpiry().challengeable, true);

    harness.advanceClock(1);
    assert.equal(harness.evaluateExpiry().staleReason, "observation_too_old");
    assert.equal(harness.evaluateExpiry().challengeable, false);

    // Refresh right at lock boundary (exactly 60s left -> open & challengeable).
    const atLockMs = (deadlineSec - DEFAULT_CHALLENGE_LOCK_SECONDS) * 1000;
    harness.advanceClock(atLockMs - harness.getNowMs());
    harness.refreshFromContract();
    assert.equal(harness.evaluateExpiry().status, "open");
    assert.equal(harness.evaluateExpiry().challengeable, true);

    // 1 second inside the lock window -> closing_soon, refuses submission.
    harness.advanceClock(1_000);
    harness.refreshFromContract();
    harness.captureReview();
    const res = await harness.submitChallenge();
    assert.equal(res.status, "refused");
    if (res.status === "refused") {
      assert.equal(res.reason, "observation_not_challengeable");
      assert.equal(res.expiry?.status, "closing_soon");
    }
  } finally {
    harness.close();
  }
});

// ── Stale market revisions & account switches ─────────────────────────────────

test("stale market revision: updated claim statement invalidates review and ticket digest", async () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    harness.refreshFromContract();
    const captured = harness.captureReview();
    assert.ok(captured);
    assert.equal(harness.isIntentReviewCurrent(), true);
    assert.equal(harness.isTicketRevisionCurrent(), true);

    const beforeTicketRev = computeChallengeTicketRevision({
      account: CHALLENGE_UX_WALLET_A,
      stakeAmount: 5,
      claim: harness.transport.getAuthoritativeVs().claim_statement,
    });
    assert.equal(captured.ticketRevision, beforeTicketRev);

    // Background observation delivers a revised claim statement.
    harness.transport.setAuthoritativeVs({
      claim_statement: "Will BTC close above $120,000 before settlement?",
      question: "Will BTC close above $120,000 before settlement?",
    });
    harness.refreshFromContract();

    assert.equal(harness.isIntentReviewCurrent(), false);
    assert.equal(harness.isTicketRevisionCurrent(), false);
    assert.equal(
      isChallengeIntentReviewValid(captured.intent, {
        claimStatement: "Will BTC close above $120,000 before settlement?",
        account: CHALLENGE_UX_WALLET_A,
        stakeAmount: 5,
      }),
      false,
    );

    const refused = await harness.submitChallenge();
    assert.equal(refused.status, "refused");
    if (refused.status === "refused") {
      assert.equal(refused.reason, "review_missing_or_stale");
    }
    assert.equal(harness.wallet.attempts(), 0);

    // Re-capturing review on the new revision allows submission.
    const nextReview = harness.captureReview();
    assert.ok(nextReview);
    assert.notEqual(nextReview.ticketRevision, beforeTicketRev);
    assert.notEqual(
      nextReview.intent.revisionKey,
      buildChallengeRevisionKey(
        "Will BTC close above $100,000 before the settlement deadline?",
        CHALLENGE_UX_WALLET_A,
        5,
      ),
    );
    const confirmed = await harness.submitChallenge();
    assert.equal(confirmed.status, "confirmed");
  } finally {
    harness.close();
  }
});

test("stale market revision: editing stake invalidates review until re-confirmed", async () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    harness.refreshFromContract();
    harness.captureReview();
    assert.equal(harness.isIntentReviewCurrent(), true);

    harness.setStake("12");
    assert.equal(harness.isIntentReviewCurrent(), false);
    assert.equal(harness.isTicketRevisionCurrent(), false);

    const refused = await harness.submitChallenge();
    assert.equal(refused.status, "refused");
    if (refused.status === "refused") {
      assert.equal(refused.reason, "review_missing_or_stale");
    }
  } finally {
    harness.close();
  }
});

test("stale market revision: account switch clears authorization, keeps draft stake, and updates ticket banner", async () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    harness.refreshFromContract();
    harness.setStake("15");
    harness.captureReview();

    // Switch wallet account mid-flow.
    harness.switchAccount(CHALLENGE_UX_WALLET_B);
    assert.equal(harness.getAuthorizationClearedFor(), CHALLENGE_UX_WALLET_B);
    assert.equal(harness.getDetailState().challengeStake, "15");
    assert.equal(harness.isIntentReviewCurrent(), false);

    const refused = await harness.submitChallenge();
    assert.equal(refused.status, "refused");
    if (refused.status === "refused") {
      assert.equal(refused.reason, "authorization_cleared");
    }

    // Verify rendered CreateChallengeTicket reflects accountChanged state.
    const changedHtml = renderTicketHtml({
      accountChanged: true,
      walletAddress: CHALLENGE_UX_WALLET_B,
      stakeAmount: 15,
    });
    assert.match(changedHtml, /Account changed/);
    assert.match(changedHtml, /UNSIGNED/);
    assert.doesNotMatch(changedHtml, />SIGNED</);

    // Re-reviewing under the new account clears the gate and allows submission.
    harness.captureReview();
    const settledHtml = renderTicketHtml({
      accountChanged: false,
      walletAddress: CHALLENGE_UX_WALLET_B,
      stakeAmount: 15,
    });
    assert.doesNotMatch(settledHtml, /Account changed/);
    assert.match(settledHtml, />SIGNED</);

    const ok = await harness.submitChallenge();
    assert.equal(ok.status, "confirmed");
    if (ok.status === "confirmed") {
      assert.equal(ok.stakeUsdc, 15);
    }
  } finally {
    harness.close();
  }
});

// ── Wallet rejection ──────────────────────────────────────────────────────────

test("wallet rejection: user decline leaves no recovery lock, preserves draft stake, and allows retry", async () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    harness.refreshFromContract();
    harness.setStake("8");
    harness.captureReview();

    harness.wallet.enqueueOutcome({
      kind: "wallet_rejected",
      message: "User declined transaction in wallet",
    });
    harness.wallet.enqueueOutcome({
      kind: "confirmed",
      txHash: CHALLENGE_UX_TX_HASH_1,
    });

    const first = await harness.submitChallenge();
    assert.equal(first.status, "wallet_rejected");
    if (first.status === "wallet_rejected") {
      assert.equal(first.uncertain, false);
      assert.equal(first.canRetryImmediately, true);
    }
    assert.equal(harness.getRecovery(), null);
    assert.equal(harness.getUncertainSubmission(), null);
    assert.equal(harness.getDetailState().challengeStake, "8");
    assert.equal(harness.transport.landedChallenges().length, 0);

    // Immediate retry succeeds without requiring reload or recovery dismissal.
    const retry = await harness.submitChallenge();
    assert.equal(retry.status, "confirmed");
    if (retry.status === "confirmed") {
      assert.equal(retry.txHash, CHALLENGE_UX_TX_HASH_1);
      assert.equal(retry.stakeUsdc, 8);
    }
    assert.equal(harness.wallet.attempts(), 2);
  } finally {
    harness.close();
  }
});

test("wallet rejection: definitive ledger 400 error is not recorded as uncertain", async () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    harness.refreshFromContract();
    harness.captureReview();

    harness.wallet.enqueueOutcome({
      kind: "ledger_rejected",
      status: 400,
      message: "tx_bad_seq",
    });

    const res = await harness.submitChallenge();
    assert.equal(res.status, "wallet_rejected");
    if (res.status === "wallet_rejected") {
      assert.equal(res.uncertain, false);
      assert.equal(res.canRetryImmediately, true);
    }
    assert.equal(harness.getRecovery(), null);
  } finally {
    harness.close();
  }
});

test("boundary: non-integer or zero USDC stakes are refused before wallet signing", async () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    harness.refreshFromContract();
    for (const badStake of ["0", "-5", "2.5", "abc"]) {
      harness.setStake(badStake);
      assert.equal(harness.captureReview(), null);
      const res = await harness.submitChallenge();
      assert.equal(res.status, "refused");
      if (res.status === "refused") {
        assert.equal(res.reason, "invalid_stake");
      }
    }
    assert.equal(harness.wallet.attempts(), 0);
  } finally {
    harness.close();
  }
});

// ── Uncertain submissions & bounded reconciliation ────────────────────────────

test("uncertain submission: blocks duplicate stake across reload and reconciles on late success", async () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    harness.refreshFromContract();
    harness.setStake("7");
    harness.captureReview();

    harness.wallet.enqueueOutcome({
      kind: "uncertain_timeout",
      txHash: CHALLENGE_UX_TX_HASH_1,
    });

    const submitted = await harness.submitChallenge();
    assert.equal(submitted.status, "uncertain_recorded");
    assert.equal(harness.wallet.attempts(), 1);
    assert.equal(harness.dismissRecovery(), false);

    // Second stake attempt is blocked while outcome is unknown.
    const duplicate = await harness.submitChallenge();
    assert.equal(duplicate.status, "refused");
    if (duplicate.status === "refused") {
      assert.equal(duplicate.reason, "recovery_blocking");
    }
    assert.equal(harness.wallet.attempts(), 1);

    // Simulate a page reload — recovery record is restored from temp state dir.
    harness.simulateReload();
    harness.refreshFromContract();
    harness.captureReview();
    const afterReload = await harness.submitChallenge();
    assert.equal(afterReload.status, "refused");
    if (afterReload.status === "refused") {
      assert.equal(afterReload.reason, "recovery_blocking");
    }

    // First probe is inconclusive (pending), second probe observes on-chain success.
    harness.transport.queueTxStatuses(CHALLENGE_UX_TX_HASH_1, ["pending", "succeeded"]);
    const check1 = await harness.reconcileRecovery();
    assert.equal(check1.probed, true);
    assert.equal(check1.recovery?.status, "unknown");
    assert.equal(check1.recovery?.statusChecks, 1);
    assert.equal(harness.dismissRecovery(), false);

    const check2 = await harness.reconcileRecovery();
    assert.equal(check2.probed, true);
    assert.equal(check2.recovery?.status, "succeeded");
    assert.equal(check2.submission?.status, "confirmed");
    assert.equal(check2.submission?.canResubmit, false);
    assert.equal(harness.wallet.attempts(), 1); // Never resubmitted
    assert.equal(harness.transport.landedChallenges().length, 1);
    assert.equal(harness.dismissRecovery(), true);
    assert.equal(harness.getRecovery(), null);
  } finally {
    harness.close();
  }
});

test("uncertain submission: exhausting bounded check budget fails closed and stops probing", async () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    harness.refreshFromContract();
    harness.captureReview();

    harness.wallet.enqueueOutcome({
      kind: "uncertain_unwrap_error",
      txHash: CHALLENGE_UX_TX_HASH_2,
    });
    const recorded = await harness.submitChallenge();
    assert.equal(recorded.status, "uncertain_recorded");

    for (let i = 1; i <= CHALLENGE_RECOVERY_MAX_STATUS_CHECKS; i += 1) {
      const res = await harness.reconcileRecovery();
      assert.equal(res.probed, true);
      assert.equal(res.recovery?.statusChecks, i);
      assert.equal(res.recovery?.status, "unknown");
    }

    // Further reconciliation calls do not hit the transport once budget is spent.
    const overBudget = await harness.reconcileRecovery();
    assert.equal(overBudget.probed, false);
    assert.equal(
      harness.transport.totalStatusProbeCalls(),
      CHALLENGE_RECOVERY_MAX_STATUS_CHECKS,
    );

    // Fail closed: exhausted budget still blocks duplicate stake and dismissal.
    assert.equal(
      isChallengeRecoveryBlocking(harness.getRecovery(), harness.getNowMs()),
      true,
    );
    assert.equal(harness.dismissRecovery(), false);
    const secondTry = await harness.submitChallenge();
    assert.equal(secondTry.status, "refused");
    if (secondTry.status === "refused") {
      assert.equal(secondTry.reason, "recovery_blocking");
    }

    // Boundary: 1 ms before MAX_AGE still blocks; at exact MAX_AGE it unblocks.
    harness.advanceClock(CHALLENGE_RECOVERY_MAX_AGE_MS - 1);
    assert.equal(
      isChallengeRecoveryBlocking(harness.getRecovery(), harness.getNowMs()),
      true,
    );
    harness.advanceClock(1);
    assert.equal(
      isChallengeRecoveryBlocking(harness.getRecovery(), harness.getNowMs()),
      false,
    );
    assert.equal(harness.dismissRecovery(), true);
  } finally {
    harness.close();
  }
});

test("uncertain submission: definitive failed probe allows dismissal and clean retry", async () => {
  const harness = new ChallengeUxFixtureHarness();
  try {
    harness.refreshFromContract();
    harness.setStake("6");
    harness.captureReview();

    harness.wallet.enqueueOutcome({
      kind: "uncertain_timeout",
      txHash: CHALLENGE_UX_TX_HASH_1,
    });
    harness.wallet.enqueueOutcome({
      kind: "confirmed",
      txHash: CHALLENGE_UX_TX_HASH_2,
    });

    const first = await harness.submitChallenge();
    assert.equal(first.status, "uncertain_recorded");

    harness.transport.queueTxStatuses(CHALLENGE_UX_TX_HASH_1, ["failed"]);
    const reconciled = await harness.reconcileRecovery();
    assert.equal(reconciled.recovery?.status, "failed");
    assert.equal(reconciled.submission?.canResubmit, true);
    assert.equal(harness.dismissRecovery(), true);

    const retry = await harness.submitChallenge();
    assert.equal(retry.status, "confirmed");
    if (retry.status === "confirmed") {
      assert.equal(retry.txHash, CHALLENGE_UX_TX_HASH_2);
      assert.equal(retry.stakeUsdc, 6);
    }
  } finally {
    harness.close();
  }
});
