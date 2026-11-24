/**
 * User-readable messaging reconnection state machine (#933).
 *
 * The XMTP provider reports a low-level transport (`not_started`,
 * `connecting`, `ready`, `unavailable`) and the composer reports what happened
 * to each send. This module folds both into the four states a person in a
 * chat actually needs to tell apart:
 *
 * | state            | meaning for the user                                        |
 * |------------------|-------------------------------------------------------------|
 * | `connecting`     | Messaging is (re)connecting. Keep typing; Send waits.       |
 * | `ready`          | Connected. Messages can be sent.                            |
 * | `unavailable`    | Messaging can't be reached right now. The draft is kept.    |
 * | `uncertain_send` | A message may or may not have been delivered. Check the     |
 * |                  | thread before resending, so it isn't sent twice.            |
 *
 * `uncertain_send` is sticky: a reconnect does not clear it, because getting
 * the connection back says nothing about whether the earlier message arrived.
 * It is cleared only when that send is resolved (seen in the thread, resent,
 * or dismissed by the user).
 *
 * Nothing here requests a wallet signature. Reconnecting reuses the cached
 * XMTP identity (see `lib/xmtp/identity.ts`), and drafts are keyed by wallet
 * address and peer (see `lib/xmtp/draft-store.ts`), so neither restoring a
 * draft nor reconnecting needs a new signature.
 */

import { classifyXmtpFailureKind, type XmtpFailureKind } from "@/lib/xmtp/failure-state";
import type { MessagesHubTransportState } from "@/lib/xmtp/messages-hub-state";

export type MessagingReconnectionStatus =
  | "connecting"
  | "ready"
  | "unavailable"
  | "uncertain_send";

export type MessagingReconnectionState = {
  /** Last transport reported by the provider, mapped to a user-facing phase. */
  transport: Exclude<MessagingReconnectionStatus, "uncertain_send">;
  /** Client temp ids of sends whose delivery could not be confirmed. */
  uncertainSendIds: readonly string[];
};

export type MessagingReconnectionEvent =
  | { type: "transport_changed"; transport: MessagesHubTransportState }
  | { type: "send_outcome_unknown"; clientTempId: string }
  | { type: "send_resolved"; clientTempId: string }
  | { type: "uncertain_dismissed" };

export const INITIAL_MESSAGING_RECONNECTION_STATE: MessagingReconnectionState = {
  transport: "connecting",
  uncertainSendIds: [],
};

function mapTransport(
  transport: MessagesHubTransportState,
): MessagingReconnectionState["transport"] {
  switch (transport) {
    case "ready":
      return "ready";
    case "unavailable":
      return "unavailable";
    // `not_started` is the state between a disconnect and the next attempt; to
    // the reader that is still "connecting", not an outage.
    case "not_started":
    case "connecting":
    default:
      return "connecting";
  }
}

export function reduceMessagingReconnection(
  state: MessagingReconnectionState,
  event: MessagingReconnectionEvent,
): MessagingReconnectionState {
  switch (event.type) {
    case "transport_changed": {
      const transport = mapTransport(event.transport);
      return transport === state.transport ? state : { ...state, transport };
    }
    case "send_outcome_unknown":
      return state.uncertainSendIds.includes(event.clientTempId)
        ? state
        : { ...state, uncertainSendIds: [...state.uncertainSendIds, event.clientTempId] };
    case "send_resolved":
      return state.uncertainSendIds.includes(event.clientTempId)
        ? {
            ...state,
            uncertainSendIds: state.uncertainSendIds.filter((id) => id !== event.clientTempId),
          }
        : state;
    case "uncertain_dismissed":
      return state.uncertainSendIds.length === 0 ? state : { ...state, uncertainSendIds: [] };
    default:
      return state;
  }
}

export function getMessagingReconnectionStatus(
  state: MessagingReconnectionState,
): MessagingReconnectionStatus {
  return state.uncertainSendIds.length > 0 ? "uncertain_send" : state.transport;
}

/** `xmtpVs` i18n keys for each status. */
export const MESSAGING_RECONNECTION_MESSAGE_KEY = {
  connecting: "reconnectConnecting",
  ready: "reconnectReady",
  unavailable: "reconnectUnavailable",
  uncertain_send: "reconnectUncertainSend",
} as const satisfies Record<MessagingReconnectionStatus, string>;

export type MessagingReconnectionView = {
  status: MessagingReconnectionStatus;
  messageKey: (typeof MESSAGING_RECONNECTION_MESSAGE_KEY)[MessagingReconnectionStatus];
  /** Send is enabled only when the transport is ready. */
  canSend: boolean;
  /** The composer always stays editable, so a draft is never blocked or lost. */
  canEditDraft: true;
};

export function describeMessagingReconnection(
  state: MessagingReconnectionState,
): MessagingReconnectionView {
  const status = getMessagingReconnectionStatus(state);
  return {
    status,
    messageKey: MESSAGING_RECONNECTION_MESSAGE_KEY[status],
    canSend: state.transport === "ready",
    canEditDraft: true,
  };
}

/**
 * Failure kinds where the message was rejected before delivery, so resending
 * is safe. Everything else (network drop, timeout, lost stream, unknown) may
 * have happened after the transport accepted the bytes, so the outcome is
 * uncertain.
 */
const DEFINITE_SEND_FAILURES: ReadonlySet<XmtpFailureKind> = new Set<XmtpFailureKind>([
  "rate_limit",
  "peer_unreachable",
  "signature_declined",
  "unsupported_wallet",
  "invalid_identity",
  "installations_limit",
  "blocked_by_tab",
]);

export type SendFailureOutcome = "failed" | "uncertain";

export function classifySendFailure(error: unknown): SendFailureOutcome {
  const kind = classifyXmtpFailureKind(error, { status: "ready" });
  return DEFINITE_SEND_FAILURES.has(kind) ? "failed" : "uncertain";
}
