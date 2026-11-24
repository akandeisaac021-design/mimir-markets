/**
 * Focused coverage for screen-reader focus and announcement preservation
 * after a challenge result refresh.
 *
 * Covers:
 *  - Polite announcements emitted only for relevant submitted or confirmed states
 *  - Deduplication across repeated background refreshes and stale generations
 *  - Keyboard focus preservation on exact surviving actions and deterministic
 *    fallback to equivalent surviving actions when the focused action unmounts
 *  - Boundary & failure cases (focus outside controls, empty surviving set,
 *    disabled/missing DOM nodes, failed recovery, already-confirmed initial load)
 *  - Backward-compatible SSR rendering of `CreateChallengeTicket`
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import CreateChallengeTicket from "../../components/vs/CreateChallengeTicket";
import type { ChallengeRecoveryRecord } from "../../lib/challenge-recovery";
import {
  applyChallengeRefreshFocusTransition,
  buildChallengeRefreshAnnouncement,
  createChallengeRefreshFocusState,
  deriveChallengeResultState,
  resolveSurvivingChallengeAction,
  restoreFocusToChallengeAction,
  type ActionQueryContainer,
  type ChallengeResultState,
  type FocusableActionElement,
} from "../../lib/challenge-refresh-focus";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRecovery(
  overrides: Partial<ChallengeRecoveryRecord> = {},
): ChallengeRecoveryRecord {
  return {
    vsId: 42,
    txHash: "txhash_abc123",
    address: "GB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E",
    stakeAmount: 10,
    submittedAt: 1_700_000_000_000,
    status: "unknown",
    statusChecks: 0,
    ...overrides,
  };
}

const TEST_MESSAGES = {
  create: {
    challengeTicketTitle: "Challenge Ticket",
    ticketIdLabel: "TICKET",
    marketType: "Market Type",
    oddsMode: "Odds Mode",
    format: "Format",
    visibility: "Visibility",
    ticketDeadline: "Deadline",
    ticketSideLabel: "Side",
    ticketDeadlineStale: "Estimated deadline may be stale.",
    settlementRule: "Settlement Rule",
    ticketSettlementFallback: "No settlement rule yet.",
    ticketYourCommitment: "Your Commitment",
    ticketAuthSig: "AUTH_SIG",
  },
};

function renderTicket(opts: {
  challengeResultState?: ChallengeResultState;
  resultTxHash?: string | null;
  onRefreshResult?: () => void;
  stakeAmount?: number;
} = {}) {
  return renderToStaticMarkup(
    React.createElement(NextIntlClientProvider, {
      locale: "en",
      messages: TEST_MESSAGES,
      timeZone: "UTC",
      children: React.createElement(CreateChallengeTicket, {
        draftId: "draft-focus-1",
        marketTypeLabel: "Binary",
        oddsModeLabel: "Fixed",
        formatLabel: "Live",
        visibilityLabel: "Public",
        settlementPreview: "Resolves YES if XLM closes above $1.00.",
        stakeAmount: opts.stakeAmount ?? 15,
        walletAddress: "GB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E",
        challengeResultState: opts.challengeResultState,
        resultTxHash: opts.resultTxHash,
        onRefreshResult: opts.onRefreshResult,
      }),
    }),
  );
}

// ── Announcement filtering & deduplication ────────────────────────────────────

test("positive: submitted state emits a polite announcement with integer USDC stake", () => {
  const { announcement, nextLastAnnouncedKey } = buildChallengeRefreshAnnouncement({
    state: "submitted",
    dedupeSubject: "tx-1",
    stakeAmount: 25,
    lastAnnouncedKey: null,
  });

  assert.ok(announcement);
  assert.equal(announcement.state, "submitted");
  assert.match(announcement.message, /25 USDC/);
  assert.match(announcement.message, /submitted/i);
  assert.equal(nextLastAnnouncedKey, "submitted:tx-1");
});

test("positive: confirmed state emits a polite announcement after submitted state", () => {
  const step1 = buildChallengeRefreshAnnouncement({
    state: "submitted",
    dedupeSubject: "tx-1",
    stakeAmount: 25,
    lastAnnouncedKey: null,
  });
  const step2 = buildChallengeRefreshAnnouncement({
    state: "confirmed",
    dedupeSubject: "tx-1",
    stakeAmount: 25,
    lastAnnouncedKey: step1.nextLastAnnouncedKey,
  });

  assert.ok(step2.announcement);
  assert.equal(step2.announcement.state, "confirmed");
  assert.match(step2.announcement.message, /25 USDC/);
  assert.match(step2.announcement.message, /confirmed/i);
  assert.equal(step2.nextLastAnnouncedKey, "confirmed:tx-1");
});

test("negative: idle state stays silent and preserves lastAnnouncedKey", () => {
  const result = buildChallengeRefreshAnnouncement({
    state: "idle",
    dedupeSubject: null,
    stakeAmount: null,
    lastAnnouncedKey: "submitted:tx-1",
  });

  assert.equal(result.announcement, null);
  assert.equal(result.nextLastAnnouncedKey, "submitted:tx-1");
});

test("negative: repeated refresh with same submitted or confirmed key does not re-announce", () => {
  const first = buildChallengeRefreshAnnouncement({
    state: "submitted",
    dedupeSubject: "tx-dup",
    stakeAmount: 10,
    lastAnnouncedKey: null,
  });
  assert.ok(first.announcement);

  const duplicate = buildChallengeRefreshAnnouncement({
    state: "submitted",
    dedupeSubject: "tx-dup",
    stakeAmount: 10,
    lastAnnouncedKey: first.nextLastAnnouncedKey,
  });
  assert.equal(duplicate.announcement, null);
  assert.equal(duplicate.nextLastAnnouncedKey, first.nextLastAnnouncedKey);
});

// ── deriveChallengeResultState ────────────────────────────────────────────────

test("deriveChallengeResultState maps unknown recovery to submitted and succeeded to confirmed", () => {
  const submitted = deriveChallengeResultState({
    recovery: makeRecovery({ status: "unknown", txHash: "tx-a", stakeAmount: 12 }),
    viewerConfirmedOnChain: false,
    hadViewerConfirmedBefore: false,
    vsId: 42,
  });
  assert.deepEqual(submitted, {
    state: "submitted",
    dedupeSubject: "tx-a",
    stakeAmount: 12,
  });

  const confirmed = deriveChallengeResultState({
    recovery: makeRecovery({ status: "succeeded", txHash: "tx-a", stakeAmount: 12 }),
    viewerConfirmedOnChain: true,
    hadViewerConfirmedBefore: false,
    vsId: 42,
  });
  assert.deepEqual(confirmed, {
    state: "confirmed",
    dedupeSubject: "tx-a",
    stakeAmount: 12,
  });
});

test("negative: failed recovery and already-confirmed initial loads stay idle", () => {
  const failed = deriveChallengeResultState({
    recovery: makeRecovery({ status: "failed" }),
    viewerConfirmedOnChain: false,
    hadViewerConfirmedBefore: false,
    vsId: 42,
  });
  assert.equal(failed.state, "idle");

  const alreadyConfirmed = deriveChallengeResultState({
    recovery: null,
    viewerConfirmedOnChain: true,
    hadViewerConfirmedBefore: true,
    vsId: 42,
  });
  assert.equal(alreadyConfirmed.state, "idle");
});

test("positive: newly observed on-chain challenger membership derives confirmed", () => {
  const newlyConfirmed = deriveChallengeResultState({
    recovery: null,
    viewerConfirmedOnChain: true,
    hadViewerConfirmedBefore: false,
    vsId: 99,
  });
  assert.deepEqual(newlyConfirmed, {
    state: "confirmed",
    dedupeSubject: "vs-99",
    stakeAmount: null,
  });
});

// ── Keyboard focus preservation on equivalent surviving action ────────────────

test("positive: exact surviving action keeps keyboard focus", () => {
  assert.equal(
    resolveSurvivingChallengeAction("accept-stake", [
      "accept-stake",
      "refresh-result",
    ]),
    "accept-stake",
  );
  assert.equal(
    resolveSurvivingChallengeAction("check-status", [
      "check-status",
      "view-explorer",
    ]),
    "check-status",
  );
});

test("positive: unmounted accept-stake moves focus to equivalent surviving action", () => {
  // After submission, stake form unmounts and recovery panel mounts check-status + view-explorer.
  assert.equal(
    resolveSurvivingChallengeAction("accept-stake", [
      "check-status",
      "view-explorer",
      "refresh-result",
    ]),
    "check-status",
  );

  // After confirmation, check-status disables/unmounts and dismiss-recovery survives.
  assert.equal(
    resolveSurvivingChallengeAction("check-status", [
      "dismiss-recovery",
      "view-explorer",
      "refresh-result",
    ]),
    "dismiss-recovery",
  );

  // When only view-explorer and refresh-result survive, focus lands on view-explorer.
  assert.equal(
    resolveSurvivingChallengeAction("check-status", [
      "view-explorer",
      "refresh-result",
    ]),
    "view-explorer",
  );
});

test("positive: confirm-review falls back to refresh-result when replaced on refresh", () => {
  assert.equal(
    resolveSurvivingChallengeAction("confirm-review", ["refresh-result"]),
    "refresh-result",
  );
});

test("boundary: null activeAction never steals focus from outside controls", () => {
  assert.equal(
    resolveSurvivingChallengeAction(null, ["check-status", "refresh-result"]),
    null,
  );
});

test("boundary: empty survivingActions returns null safely", () => {
  assert.equal(resolveSurvivingChallengeAction("accept-stake", []), null);
});

// ── State-machine transition & stale generation guard ─────────────────────────

test("regression: stale generation refresh neither announces nor moves focus", () => {
  const initial = createChallengeRefreshFocusState();
  const afterStale = applyChallengeRefreshFocusTransition(initial, {
    nextResultState: "confirmed",
    dedupeSubject: "stale-tx",
    stakeAmount: 20,
    activeAction: "accept-stake",
    survivingActions: ["dismiss-recovery"],
    isStaleGeneration: true,
  });

  assert.equal(afterStale, initial);
  assert.equal(afterStale.announcement, null);
  assert.equal(afterStale.focusTarget, null);
});

test("positive: end-to-end submitted -> duplicate poll -> confirmed transition", () => {
  const s0 = createChallengeRefreshFocusState();

  const s1 = applyChallengeRefreshFocusTransition(s0, {
    nextResultState: "submitted",
    dedupeSubject: "tx-77",
    stakeAmount: 10,
    activeAction: "accept-stake",
    survivingActions: ["check-status", "view-explorer"],
  });
  assert.equal(s1.resultState, "submitted");
  assert.equal(s1.announcement?.state, "submitted");
  assert.equal(s1.focusTarget, "check-status");

  // Routine poll observing the same submitted state keeps the same announcement reference
  // (no live-region mutation) and preserves focus on check-status.
  const s2 = applyChallengeRefreshFocusTransition(s1, {
    nextResultState: "submitted",
    dedupeSubject: "tx-77",
    stakeAmount: 10,
    activeAction: "check-status",
    survivingActions: ["check-status", "view-explorer"],
  });
  assert.equal(s2.announcement, s1.announcement);
  assert.equal(s2.focusTarget, "check-status");

  // Confirmation refresh announces confirmed and moves focus to dismiss-recovery.
  const s3 = applyChallengeRefreshFocusTransition(s2, {
    nextResultState: "confirmed",
    dedupeSubject: "tx-77",
    stakeAmount: 10,
    activeAction: "check-status",
    survivingActions: ["dismiss-recovery", "view-explorer"],
  });
  assert.equal(s3.resultState, "confirmed");
  assert.equal(s3.announcement?.state, "confirmed");
  assert.equal(s3.focusTarget, "dismiss-recovery");
});

// ── Synthetic DOM focus restoration ───────────────────────────────────────────

test("positive: restoreFocusToChallengeAction focuses enabled target with preventScroll", () => {
  let focused = false;
  let receivedOpts: { preventScroll?: boolean } | undefined;
  const button: FocusableActionElement = {
    disabled: false,
    getAttribute: () => null,
    focus(opts) {
      focused = true;
      receivedOpts = opts;
    },
  };
  const container: ActionQueryContainer = {
    querySelector(selector) {
      return selector === '[data-challenge-action="dismiss-recovery"]' ? button : null;
    },
  };

  const ok = restoreFocusToChallengeAction(container, "dismiss-recovery");
  assert.equal(ok, true);
  assert.equal(focused, true);
  assert.deepEqual(receivedOpts, { preventScroll: true });
});

test("failure/boundary: restoreFocusToChallengeAction fails closed on disabled, missing, or throwing node", () => {
  const disabledButton: FocusableActionElement = {
    disabled: true,
    focus() {
      throw new Error("should not be called");
    },
  };
  const ariaDisabledButton: FocusableActionElement = {
    getAttribute: (name) => (name === "aria-disabled" ? "true" : null),
    focus() {
      throw new Error("should not be called");
    },
  };
  const throwingButton: FocusableActionElement = {
    focus() {
      throw new Error("detached node");
    },
  };

  const container: ActionQueryContainer = {
    querySelector(selector) {
      if (selector.includes("check-status")) return disabledButton;
      if (selector.includes("view-explorer")) return ariaDisabledButton;
      if (selector.includes("refresh-result")) return throwingButton;
      return null;
    },
  };

  assert.equal(restoreFocusToChallengeAction(container, "check-status"), false);
  assert.equal(restoreFocusToChallengeAction(container, "view-explorer"), false);
  assert.equal(restoreFocusToChallengeAction(container, "refresh-result"), false);
  assert.equal(restoreFocusToChallengeAction(container, "accept-stake"), false);
  assert.equal(restoreFocusToChallengeAction(null, "accept-stake"), false);
  assert.equal(restoreFocusToChallengeAction(container, null), false);
});

// ── CreateChallengeTicket SSR coverage ────────────────────────────────────────

test("backward compatibility: CreateChallengeTicket with default props renders silent live region and confirm-review action", () => {
  const html = renderTicket();
  assert.match(html, /data-testid="challenge-result-live-region"/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-atomic="true"/);
  assert.match(html, /data-challenge-action="confirm-review"/);
  assert.doesNotMatch(html, /Challenge stake of/);
  assert.doesNotMatch(html, /data-challenge-action="refresh-result"/);
});

test("positive: CreateChallengeTicket announces submitted state and exposes surviving refresh-result action", () => {
  const html = renderTicket({
    challengeResultState: "submitted",
    resultTxHash: "tx-sub-1",
    stakeAmount: 15,
    onRefreshResult: () => {},
  });
  assert.match(
    html,
    /Challenge stake of 15 USDC submitted\. Awaiting on-chain confirmation\./,
  );
  assert.match(html, /data-challenge-action="refresh-result"/);
  assert.doesNotMatch(html, /data-challenge-action="confirm-review"/);
});

test("positive: CreateChallengeTicket announces confirmed state and exposes surviving refresh-result action", () => {
  const html = renderTicket({
    challengeResultState: "confirmed",
    resultTxHash: "tx-conf-1",
    stakeAmount: 15,
    onRefreshResult: () => {},
  });
  assert.match(html, /Challenge stake of 15 USDC confirmed on-chain\./);
  assert.match(html, /data-challenge-action="refresh-result"/);
});

test("negative: CreateChallengeTicket with idle state stays silent even when onRefreshResult is provided", () => {
  const html = renderTicket({
    challengeResultState: "idle",
    onRefreshResult: () => {},
  });
  assert.doesNotMatch(html, /Challenge stake of/);
  assert.match(html, /data-challenge-action="confirm-review"/);
  assert.doesNotMatch(html, /data-challenge-action="refresh-result"/);
});
