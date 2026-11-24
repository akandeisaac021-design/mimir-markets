/**
 * Per-conversation message drafts that survive reconnects and remounts (#933).
 *
 * Drafts are keyed by the viewer's wallet address and the peer address, not by
 * the XMTP inbox id. The inbox id only exists once an XMTP client has been
 * created (which can require a wallet signature), so keying on it would make
 * restoring a draft depend on signing again. With wallet + peer the draft is
 * available immediately, while messaging is still connecting or unavailable.
 *
 * Storage is `sessionStorage`: drafts stay in this tab and are dropped when it
 * closes, so plaintext does not linger across sessions or other tabs. Every
 * access is wrapped because storage can be missing or throw (private mode,
 * blocked site data, SSR).
 */

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY_PREFIX = "mimir.xmtp.draft.v1";
/** Upper bound on a stored draft, so a pasted blob cannot fill the quota. */
export const MAX_STORED_DRAFT_LENGTH = 4000;

export function xmtpDraftStorageKey(viewerAddress: string, peerAddress: string): string {
  return `${KEY_PREFIX}:${viewerAddress.trim().toLowerCase()}:${peerAddress.trim().toLowerCase()}`;
}

function defaultStorage(): DraftStorage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function readXmtpDraft(
  viewerAddress: string | null | undefined,
  peerAddress: string | null | undefined,
  storage: DraftStorage | null = defaultStorage(),
): string {
  if (!storage || !viewerAddress || !peerAddress) return "";
  try {
    return storage.getItem(xmtpDraftStorageKey(viewerAddress, peerAddress)) ?? "";
  } catch {
    return "";
  }
}

/** Saves `draft`, or removes the entry when it is blank. Never throws. */
export function writeXmtpDraft(
  viewerAddress: string | null | undefined,
  peerAddress: string | null | undefined,
  draft: string,
  storage: DraftStorage | null = defaultStorage(),
): void {
  if (!storage || !viewerAddress || !peerAddress) return;
  const key = xmtpDraftStorageKey(viewerAddress, peerAddress);
  try {
    if (!draft.trim()) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, draft.slice(0, MAX_STORED_DRAFT_LENGTH));
    }
  } catch {
    /* quota or access errors: the in-memory draft is still intact */
  }
}

export function clearXmtpDraft(
  viewerAddress: string | null | undefined,
  peerAddress: string | null | undefined,
  storage: DraftStorage | null = defaultStorage(),
): void {
  writeXmtpDraft(viewerAddress, peerAddress, "", storage);
}
