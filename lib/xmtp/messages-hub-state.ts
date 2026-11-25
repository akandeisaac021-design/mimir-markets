export type MessagesHubTransportState =
  | "not_started"
  | "connecting"
  | "ready"
  | "unavailable";

export type MessagesHubConnectionState = {
  signingSupported: boolean;
  transport: MessagesHubTransportState;
};

export type MessagesHubConnectionInput = {
  canSignMessages: boolean;
  status: "idle" | "disabled" | "initializing" | "ready" | "error" | "blocked_by_tab";
  failureKind?: string | null;
};

export function getMessagesHubConnectionState({
  canSignMessages,
  status,
  failureKind,
}: MessagesHubConnectionInput): MessagesHubConnectionState {
  const signingSupported =
    canSignMessages && failureKind !== "unsupported_wallet";

  if (!signingSupported) {
    return { signingSupported, transport: "not_started" };
  }

  if (
    failureKind === "signature_declined" ||
    failureKind === "invalid_identity"
  ) {
    return { signingSupported, transport: "not_started" };
  }

  if (status === "ready") {
    return { signingSupported, transport: "ready" };
  }

  if (status === "idle" || status === "initializing") {
    return { signingSupported, transport: "connecting" };
  }

  return { signingSupported, transport: "unavailable" };
}

/**
 * The thread rows the hub may show for the connected account.
 *
 * The hub keeps the last fetch in state while the next one is in flight, and a
 * wallet switch does not remount the page. Returning nothing unless the rows
 * were loaded for exactly this account means another account's conversations
 * can never be painted during that window — not even for a frame.
 */
export function messagesHubVisibleThreads<T>(
  loaded: { address: string | null; items: readonly T[] },
  address: string | null,
): readonly T[] {
  if (!address || loaded.address !== address) return [];
  return loaded.items;
}

/**
 * A private conversation context currently loaded into the hub.
 *
 * Message bodies are end-to-end encrypted and only exist in the XMTP client;
 * this is the render-side record of *whose* content is on screen. It carries an
 * optional expiry so a caller that keeps content mounted past its useful life
 * (a resumed session, a scheduled teardown) can stop showing it without relying
 * on an unmount that may never happen.
 */
export type MessagesHubPrivateContext = {
  /** Wallet account the loaded conversation content belongs to. */
  viewerAddress: string;
  /** Epoch ms when the content stops being displayable; null = no time limit. */
  expiresAt: number | null;
};

export type MessagesHubPrivateContextState =
  | { visible: true; reason: "visible" }
  | {
      visible: false;
      reason: "no_context" | "no_account" | "account_changed" | "expired";
    };

/**
 * Whether loaded private content may be shown to the current account.
 *
 * The order matters: content loaded for another account is refused before any
 * expiry check, because showing it at all would be a leak even while its clock
 * is still valid.
 */
export function resolveMessagesHubPrivateContext({
  address,
  context,
  nowMs,
}: {
  address: string | null;
  context: MessagesHubPrivateContext | null;
  nowMs: number;
}): MessagesHubPrivateContextState {
  if (!context) return { visible: false, reason: "no_context" };
  if (!address) return { visible: false, reason: "no_account" };
  if (context.viewerAddress !== address) {
    return { visible: false, reason: "account_changed" };
  }
  if (
    context.expiresAt != null &&
    Number.isFinite(context.expiresAt) &&
    nowMs >= context.expiresAt
  ) {
    return { visible: false, reason: "expired" };
  }
  return { visible: true, reason: "visible" };
}
