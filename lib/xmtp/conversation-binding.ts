/**
 * Market-context binding review for private (XMTP) conversations.
 *
 * Before the messages hub opens a 1:1 conversation it shows the user *which*
 * market and *which* counterpart the conversation is bound to, and only opens
 * it once the user confirms. The values shown come from trusted context — the
 * thread rows the hub fetched for exactly the connected account — never from
 * the URL or other navigation state. Navigation state is treated as an
 * untrusted hint: it can preselect a thread for review, but it can never open
 * one, and a hint that disagrees with trusted context is refused.
 *
 * A confirmation is a snapshot (a fingerprint of the reviewed context). If the
 * account, the selection, or the trusted context changes after the review, the
 * snapshot no longer matches and the conversation stays closed until the user
 * reviews again.
 *
 * Pure module: no React, no XMTP SDK, safe for node tests.
 */

import type { VSData } from "@/lib/contract";
import { messagesHubVisibleThreads } from "@/lib/xmtp/messages-hub-state";
import {
  canOpenVsXmtpChat,
  getVsXmtpPeerAddress,
  isSampleVsIdForXmtp,
} from "@/lib/xmtp/vs-chat-eligibility";

/** Bump when the fingerprint shape changes so old confirmations never match. */
export const CONVERSATION_BINDING_VERSION = "v1";

/** Query parameters the hub accepts as an (untrusted) preselection hint. */
export const CONVERSATION_HINT_MARKET_PARAM = "vs";
export const CONVERSATION_HINT_PEER_PARAM = "peer";

/** Rows the hub loaded, tagged with the account they were loaded for. */
export type TrustedConversationContext = {
  address: string | null;
  items: readonly VSData[];
};

/** What the review step shows, all derived from trusted context. */
export type ConversationBindingReview = {
  vsId: number;
  question: string;
  marketState: VSData["state"];
  /** Connected account the conversation belongs to. */
  viewerAddress: string;
  /** The other side of the 1v1, resolved from the on-chain creator/opponent. */
  peerAddress: string;
  /** Stable digest of everything above; what a confirmation binds to. */
  fingerprint: string;
};

export type ConversationBindingReviewFailure =
  | "no_account"
  | "context_not_loaded"
  | "market_not_found"
  | "not_eligible"
  | "not_participant";

export type ConversationBindingReviewResult =
  | { ok: true; review: ConversationBindingReview }
  | { ok: false; reason: ConversationBindingReviewFailure };

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function conversationBindingFingerprint(
  review: Omit<ConversationBindingReview, "fingerprint">,
): string {
  return JSON.stringify([
    CONVERSATION_BINDING_VERSION,
    review.vsId,
    review.viewerAddress.trim().toLowerCase(),
    review.peerAddress.trim().toLowerCase(),
    review.marketState,
    review.question,
  ]);
}

/**
 * Build the review for `vsId` from the rows loaded for `address`.
 *
 * Refuses when the rows were loaded for another account (or not loaded yet),
 * when the market is not one of the account's threads, when the market cannot
 * host a private conversation, or when the account is not a participant.
 */
export function buildConversationBindingReview({
  trusted,
  address,
  vsId,
}: {
  trusted: TrustedConversationContext;
  address: string | null;
  vsId: number;
}): ConversationBindingReviewResult {
  if (!address) return { ok: false, reason: "no_account" };
  if (trusted.address !== address) {
    return { ok: false, reason: "context_not_loaded" };
  }
  const rows = messagesHubVisibleThreads(trusted, address);
  const vs = rows.find((row) => row.id === vsId);
  if (!vs) return { ok: false, reason: "market_not_found" };
  if (isSampleVsIdForXmtp(vs.id) || !canOpenVsXmtpChat(vs)) {
    return { ok: false, reason: "not_eligible" };
  }
  const peerAddress = getVsXmtpPeerAddress(vs, address);
  if (!peerAddress) return { ok: false, reason: "not_participant" };

  const base = {
    vsId: vs.id,
    question: vs.question,
    marketState: vs.state,
    viewerAddress: address,
    peerAddress,
  };
  return {
    ok: true,
    review: { ...base, fingerprint: conversationBindingFingerprint(base) },
  };
}

/** Untrusted preselection hint read from the URL query. */
export type ConversationNavigationHint = {
  vsId: number | null;
  peerAddress: string | null;
  /** True when a hint was present but could not be parsed. */
  malformed: boolean;
};

/**
 * Parse `?vs=<id>&peer=<address>`. Returns null when neither parameter is
 * present (the hub's default, no-hint behaviour).
 */
export function parseConversationNavigationHint(
  search: string | URLSearchParams | null | undefined,
): ConversationNavigationHint | null {
  if (search == null) return null;
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const rawVs = params.get(CONVERSATION_HINT_MARKET_PARAM);
  const rawPeer = params.get(CONVERSATION_HINT_PEER_PARAM);
  if (rawVs == null && rawPeer == null) return null;

  const peerAddress = rawPeer?.trim() ? rawPeer.trim() : null;
  if (rawVs == null || !/^\d+$/.test(rawVs.trim())) {
    return { vsId: null, peerAddress, malformed: true };
  }
  const vsId = Number(rawVs.trim());
  if (!Number.isSafeInteger(vsId)) {
    return { vsId: null, peerAddress, malformed: true };
  }
  return { vsId, peerAddress, malformed: rawPeer != null && !peerAddress };
}

export type ConversationHintFailure =
  | "malformed_hint"
  | ConversationBindingReviewFailure
  | "peer_mismatch";

export type ConversationHintResult =
  | { ok: true; review: ConversationBindingReview }
  | { ok: false; reason: ConversationHintFailure };

/**
 * Check a navigation hint against trusted context. Success only means the hint
 * may *preselect* the thread for review; it never confirms anything.
 */
export function resolveConversationNavigationHint({
  hint,
  trusted,
  address,
}: {
  hint: ConversationNavigationHint;
  trusted: TrustedConversationContext;
  address: string | null;
}): ConversationHintResult {
  if (hint.malformed || hint.vsId == null) {
    return { ok: false, reason: "malformed_hint" };
  }
  const built = buildConversationBindingReview({
    trusted,
    address,
    vsId: hint.vsId,
  });
  if (!built.ok) return built;
  if (hint.peerAddress && !sameAddress(hint.peerAddress, built.review.peerAddress)) {
    return { ok: false, reason: "peer_mismatch" };
  }
  return built;
}

/** What the user confirmed: a snapshot of the review they saw. */
export type ConfirmedConversationBinding = {
  vsId: number;
  viewerAddress: string;
  fingerprint: string;
  confirmedAt: number;
};

export function confirmConversationBinding(
  review: ConversationBindingReview,
  nowMs: number,
): ConfirmedConversationBinding {
  return {
    vsId: review.vsId,
    viewerAddress: review.viewerAddress,
    fingerprint: review.fingerprint,
    confirmedAt: nowMs,
  };
}

export type ConversationBindingState =
  | { open: true; review: ConversationBindingReview }
  | {
      open: false;
      reason:
        | "not_confirmed"
        | "selection_changed"
        | "account_changed"
        | "context_changed"
        | ConversationBindingReviewFailure;
      /** The current trusted review to show, when one can be built. */
      review: ConversationBindingReview | null;
    };

/**
 * Whether the selected conversation may open now.
 *
 * Opens only when the user confirmed a review of exactly the selected market,
 * for exactly the connected account, and the trusted context still produces
 * the same fingerprint. Anything else keeps it closed and, where possible,
 * hands back a fresh review so the user can confirm again.
 */
export function resolveConversationBinding({
  confirmed,
  selectedVsId,
  trusted,
  address,
}: {
  confirmed: ConfirmedConversationBinding | null;
  selectedVsId: number;
  trusted: TrustedConversationContext;
  address: string | null;
}): ConversationBindingState {
  const built = buildConversationBindingReview({
    trusted,
    address,
    vsId: selectedVsId,
  });
  if (!built.ok) return { open: false, reason: built.reason, review: null };
  const review = built.review;

  if (!confirmed) return { open: false, reason: "not_confirmed", review };
  if (confirmed.vsId !== selectedVsId) {
    return { open: false, reason: "selection_changed", review };
  }
  if (!address || confirmed.viewerAddress !== address) {
    return { open: false, reason: "account_changed", review };
  }
  if (confirmed.fingerprint !== review.fingerprint) {
    return { open: false, reason: "context_changed", review };
  }
  return { open: true, review };
}
