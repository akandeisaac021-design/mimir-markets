/**
 * Pure screen-reader announcement and keyboard focus-preservation logic for
 * challenge result refreshes.
 *
 * Kept framework-free so it can be unit-tested with `node:test` without jsdom
 * or a browser runtime. Consumed by `hooks/useVsDetail.ts` and
 * `components/vs/CreateChallengeTicket.tsx`.
 *
 * Design invariants:
 *  1. Only relevant `submitted` or `confirmed` challenge states produce a
 *     polite screen-reader announcement. Routine polls, idle refreshes, failed
 *     states, and duplicate observations of the same state stay silent.
 *  2. Keyboard focus is preserved on the currently focused action if it
 *     survives the refresh; when that action unmounts or becomes disabled,
 *     focus moves to the equivalent surviving action in a deterministic
 *     fallback chain.
 *  3. Focus is never stolen when the user is focused outside the challenge
 *     action group (`activeAction === null`), and stale/superseded fetch
 *     generations never trigger announcements or focus jumps.
 */

import type { ChallengeRecoveryRecord } from "./challenge-recovery";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Challenge lifecycle states relevant to post-refresh screen-reader
 * announcements. `"idle"` covers initial loads, routine background polls,
 * unchanged snapshots, and non-submitted/non-confirmed states.
 */
export type ChallengeResultState = "idle" | "submitted" | "confirmed";

/**
 * Polite live-region announcement emitted only when a challenge transitions to
 * a new `"submitted"` or `"confirmed"` state.
 */
export interface ChallengeRefreshAnnouncement {
  /** Only submitted or confirmed states may be announced. */
  state: "submitted" | "confirmed";
  /** Concise screen-reader message rendered inside `role="status"`. */
  message: string;
  /** Deterministic key used to suppress duplicate announcements across polls. */
  dedupeKey: string;
}

/**
 * Canonical keyboard action identifiers shared across the market detail
 * challenge controls, recovery panel, and challenge ticket.
 */
export type ChallengeActionId =
  | "accept-stake"
  | "confirm-review"
  | "check-status"
  | "dismiss-recovery"
  | "view-explorer"
  | "refresh-result";

/**
 * Focus and announcement state tracked across challenge result refreshes.
 */
export interface ChallengeRefreshFocusState {
  /** Latest derived challenge result state. */
  resultState: ChallengeResultState;
  /** Current polite live-region announcement, or null when silent. */
  announcement: ChallengeRefreshAnnouncement | null;
  /** Deduplication key of the last emitted announcement. */
  lastAnnouncedKey: string | null;
  /** Last known focused action inside the challenge flow, if any. */
  lastFocusedAction: ChallengeActionId | null;
  /** Surviving action that should hold keyboard focus after refresh, or null. */
  focusTarget: ChallengeActionId | null;
}

/**
 * Minimal structural interface for a focusable DOM node so focus restoration
 * can be exercised with synthetic test doubles as well as real browsers.
 */
export interface FocusableActionElement {
  disabled?: boolean;
  getAttribute?: (name: string) => string | null;
  focus: (options?: { preventScroll?: boolean }) => void;
}

/**
 * Minimal structural interface for a container holding challenge action nodes.
 */
export interface ActionQueryContainer {
  querySelector: (selector: string) => FocusableActionElement | null;
}

// ── Fallback map ──────────────────────────────────────────────────────────────

/**
 * Ordered equivalent-action fallback chains. The first surviving (mounted and
 * enabled) action in the chain receives keyboard focus when the previously
 * focused action disappears or becomes disabled after a refresh.
 */
export const CHALLENGE_ACTION_FALLBACKS: Readonly<
  Record<ChallengeActionId, readonly ChallengeActionId[]>
> = {
  "accept-stake": [
    "accept-stake",
    "check-status",
    "dismiss-recovery",
    "view-explorer",
    "refresh-result",
  ],
  "confirm-review": [
    "confirm-review",
    "refresh-result",
    "check-status",
    "view-explorer",
    "dismiss-recovery",
  ],
  "check-status": [
    "check-status",
    "dismiss-recovery",
    "view-explorer",
    "refresh-result",
  ],
  "dismiss-recovery": [
    "dismiss-recovery",
    "refresh-result",
    "view-explorer",
    "accept-stake",
  ],
  "view-explorer": [
    "view-explorer",
    "dismiss-recovery",
    "refresh-result",
  ],
  "refresh-result": [
    "refresh-result",
    "check-status",
    "dismiss-recovery",
    "view-explorer",
    "confirm-review",
    "accept-stake",
  ],
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Initial silent state with no pending announcement or focus target. */
export function createChallengeRefreshFocusState(): ChallengeRefreshFocusState {
  return {
    resultState: "idle",
    announcement: null,
    lastAnnouncedKey: null,
    lastFocusedAction: null,
    focusTarget: null,
  };
}

/**
 * Derive whether the latest challenge observation represents a relevant
 * `"submitted"` or `"confirmed"` state.
 *
 * - Recovery `status === "succeeded"` -> `"confirmed"` (keyed by txHash)
 * - Recovery `status === "unknown"` -> `"submitted"` (keyed by txHash)
 * - Newly observed on-chain challenger membership after initial load ->
 *   `"confirmed"` (keyed by `vsId`)
 * - Everything else (routine polls, already-confirmed initial load, failed
 *   recovery, no wallet) -> `"idle"`
 */
export function deriveChallengeResultState(input: {
  recovery: ChallengeRecoveryRecord | null;
  viewerConfirmedOnChain: boolean;
  hadViewerConfirmedBefore: boolean;
  vsId?: number | null;
}): {
  state: ChallengeResultState;
  dedupeSubject: string | null;
  stakeAmount: number | null;
} {
  if (input.recovery?.status === "succeeded") {
    return {
      state: "confirmed",
      dedupeSubject: input.recovery.txHash,
      stakeAmount: input.recovery.stakeAmount,
    };
  }
  if (input.recovery?.status === "unknown") {
    return {
      state: "submitted",
      dedupeSubject: input.recovery.txHash,
      stakeAmount: input.recovery.stakeAmount,
    };
  }
  if (input.viewerConfirmedOnChain && !input.hadViewerConfirmedBefore) {
    return {
      state: "confirmed",
      dedupeSubject:
        typeof input.vsId === "number" && Number.isFinite(input.vsId)
          ? `vs-${input.vsId}`
          : "onchain",
      stakeAmount: null,
    };
  }
  return {
    state: "idle",
    dedupeSubject: null,
    stakeAmount: null,
  };
}

/**
 * Format a concise polite live-region message for a `"submitted"` or
 * `"confirmed"` state, returning `null` for `"idle"` or duplicate keys.
 */
export function buildChallengeRefreshAnnouncement(input: {
  state: ChallengeResultState;
  dedupeSubject?: string | null;
  stakeAmount?: number | null;
  lastAnnouncedKey: string | null;
}): {
  announcement: ChallengeRefreshAnnouncement | null;
  nextLastAnnouncedKey: string | null;
} {
  if (input.state !== "submitted" && input.state !== "confirmed") {
    return {
      announcement: null,
      nextLastAnnouncedKey: input.lastAnnouncedKey,
    };
  }

  const subject = input.dedupeSubject?.trim() || "default";
  const dedupeKey = `${input.state}:${subject}`;
  if (dedupeKey === input.lastAnnouncedKey) {
    return {
      announcement: null,
      nextLastAnnouncedKey: input.lastAnnouncedKey,
    };
  }

  const hasValidStake =
    typeof input.stakeAmount === "number" &&
    Number.isFinite(input.stakeAmount) &&
    input.stakeAmount > 0;
  const stakeLabel = hasValidStake ? `${Math.trunc(input.stakeAmount!)} USDC` : null;

  const message =
    input.state === "submitted"
      ? stakeLabel
        ? `Challenge stake of ${stakeLabel} submitted. Awaiting on-chain confirmation.`
        : "Challenge submitted. Awaiting on-chain confirmation."
      : stakeLabel
        ? `Challenge stake of ${stakeLabel} confirmed on-chain.`
        : "Challenge confirmed on-chain.";

  return {
    announcement: {
      state: input.state,
      message,
      dedupeKey,
    },
    nextLastAnnouncedKey: dedupeKey,
  };
}

/**
 * Resolve which action should hold keyboard focus after a challenge refresh.
 *
 * - Returns `null` when `activeAction` is `null` (user focus is outside the
 *   challenge controls — never steal focus).
 * - Returns `activeAction` unchanged when it still exists in `survivingActions`.
 * - Otherwise selects the first surviving action from
 *   `CHALLENGE_ACTION_FALLBACKS[activeAction]`, or `null` if none survive.
 */
export function resolveSurvivingChallengeAction(
  activeAction: ChallengeActionId | null,
  survivingActions: readonly ChallengeActionId[],
): ChallengeActionId | null {
  if (!activeAction || survivingActions.length === 0) {
    return null;
  }

  const survivingSet = new Set<ChallengeActionId>(survivingActions);
  if (survivingSet.has(activeAction)) {
    return activeAction;
  }

  const fallbacks = CHALLENGE_ACTION_FALLBACKS[activeAction];
  if (!fallbacks) {
    return null;
  }

  for (const candidate of fallbacks) {
    if (survivingSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Apply a challenge result refresh to the focus/announcement state machine.
 *
 * Stale/superseded fetch generations return `prev` unchanged so late responses
 * never emit out-of-order announcements or move keyboard focus.
 */
export function applyChallengeRefreshFocusTransition(
  prev: ChallengeRefreshFocusState,
  input: {
    nextResultState: ChallengeResultState;
    dedupeSubject?: string | null;
    stakeAmount?: number | null;
    activeAction: ChallengeActionId | null;
    survivingActions: readonly ChallengeActionId[];
    isStaleGeneration?: boolean;
  },
): ChallengeRefreshFocusState {
  if (input.isStaleGeneration) {
    return prev;
  }

  const { announcement, nextLastAnnouncedKey } = buildChallengeRefreshAnnouncement({
    state: input.nextResultState,
    dedupeSubject: input.dedupeSubject,
    stakeAmount: input.stakeAmount,
    lastAnnouncedKey: prev.lastAnnouncedKey,
  });

  const focusTarget = resolveSurvivingChallengeAction(
    input.activeAction,
    input.survivingActions,
  );

  return {
    resultState: input.nextResultState,
    announcement: announcement ?? (input.nextResultState === "idle" ? null : prev.announcement),
    lastAnnouncedKey: nextLastAnnouncedKey,
    lastFocusedAction: input.activeAction,
    focusTarget,
  };
}

/**
 * Move keyboard focus to the DOM element tagged with
 * `data-challenge-action="<targetAction>"` inside `container`.
 *
 * Fails closed (returns `false`, never throws) if the container is missing,
 * the target action is `null`, the node is absent, or the node is disabled.
 */
export function restoreFocusToChallengeAction(
  container: ActionQueryContainer | null | undefined,
  targetAction: ChallengeActionId | null,
): boolean {
  if (!container || !targetAction) {
    return false;
  }

  const element = container.querySelector(
    `[data-challenge-action="${targetAction}"]`,
  );
  if (!element || typeof element.focus !== "function") {
    return false;
  }
  if (
    element.disabled ||
    element.getAttribute?.("aria-disabled") === "true"
  ) {
    return false;
  }

  try {
    element.focus({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}
