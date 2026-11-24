/**
 * #933 — user-readable messaging reconnection state machine.
 *
 * Covers the reducer (connecting / ready / unavailable / uncertain_send), the
 * send-failure classification that decides between "not sent" and "maybe
 * delivered", the wallet-keyed draft store, and the panel wiring.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  classifySendFailure,
  describeMessagingReconnection,
  getMessagingReconnectionStatus,
  INITIAL_MESSAGING_RECONNECTION_STATE,
  MESSAGING_RECONNECTION_MESSAGE_KEY,
  reduceMessagingReconnection,
  type MessagingReconnectionEvent,
  type MessagingReconnectionState,
} from "../../lib/xmtp/reconnection-state.ts";
import {
  clearXmtpDraft,
  MAX_STORED_DRAFT_LENGTH,
  readXmtpDraft,
  writeXmtpDraft,
  xmtpDraftStorageKey,
  type DraftStorage,
} from "../../lib/xmtp/draft-store.ts";

function run(events: MessagingReconnectionEvent[]): MessagingReconnectionState {
  return events.reduce(reduceMessagingReconnection, INITIAL_MESSAGING_RECONNECTION_STATE);
}

const status = (events: MessagingReconnectionEvent[]) =>
  getMessagingReconnectionStatus(run(events));

// ── State machine ─────────────────────────────────────────────────────────────

test("starts as connecting with Send disabled but the draft editable", () => {
  const view = describeMessagingReconnection(INITIAL_MESSAGING_RECONNECTION_STATE);
  assert.equal(view.status, "connecting");
  assert.equal(view.canSend, false);
  assert.equal(view.canEditDraft, true);
  assert.equal(view.messageKey, "reconnectConnecting");
});

test("maps provider transports to connecting, ready and unavailable", () => {
  assert.equal(status([{ type: "transport_changed", transport: "connecting" }]), "connecting");
  assert.equal(status([{ type: "transport_changed", transport: "not_started" }]), "connecting");
  assert.equal(status([{ type: "transport_changed", transport: "ready" }]), "ready");
  assert.equal(status([{ type: "transport_changed", transport: "unavailable" }]), "unavailable");

  const ready = describeMessagingReconnection(
    run([{ type: "transport_changed", transport: "ready" }]),
  );
  assert.equal(ready.canSend, true);
  const down = describeMessagingReconnection(
    run([{ type: "transport_changed", transport: "unavailable" }]),
  );
  assert.equal(down.canSend, false);
  assert.equal(down.canEditDraft, true);
});

test("a full drop-and-recover cycle returns to ready", () => {
  assert.equal(
    status([
      { type: "transport_changed", transport: "ready" },
      { type: "transport_changed", transport: "unavailable" },
      { type: "transport_changed", transport: "connecting" },
      { type: "transport_changed", transport: "ready" },
    ]),
    "ready",
  );
});

test("uncertain_send is sticky across a reconnect until resolved", () => {
  const events: MessagingReconnectionEvent[] = [
    { type: "transport_changed", transport: "ready" },
    { type: "send_outcome_unknown", clientTempId: "m1" },
    { type: "transport_changed", transport: "unavailable" },
    { type: "transport_changed", transport: "ready" },
  ];
  const state = run(events);
  assert.equal(getMessagingReconnectionStatus(state), "uncertain_send");
  // Sending is still governed by the transport, not blocked by the warning.
  assert.equal(describeMessagingReconnection(state).canSend, true);
  assert.equal(
    getMessagingReconnectionStatus(
      reduceMessagingReconnection(state, { type: "send_resolved", clientTempId: "m1" }),
    ),
    "ready",
  );
});

test("multiple uncertain sends clear one at a time, or all on dismiss", () => {
  const state = run([
    { type: "transport_changed", transport: "ready" },
    { type: "send_outcome_unknown", clientTempId: "a" },
    { type: "send_outcome_unknown", clientTempId: "b" },
    { type: "send_outcome_unknown", clientTempId: "a" }, // duplicate is ignored
  ]);
  assert.deepEqual(state.uncertainSendIds, ["a", "b"]);
  const one = reduceMessagingReconnection(state, { type: "send_resolved", clientTempId: "a" });
  assert.equal(getMessagingReconnectionStatus(one), "uncertain_send");
  const none = reduceMessagingReconnection(state, { type: "uncertain_dismissed" });
  assert.equal(getMessagingReconnectionStatus(none), "ready");
});

test("no-op events return the same state object", () => {
  const ready = run([{ type: "transport_changed", transport: "ready" }]);
  assert.equal(
    reduceMessagingReconnection(ready, { type: "transport_changed", transport: "ready" }),
    ready,
  );
  assert.equal(
    reduceMessagingReconnection(ready, { type: "send_resolved", clientTempId: "missing" }),
    ready,
  );
  assert.equal(reduceMessagingReconnection(ready, { type: "uncertain_dismissed" }), ready);
});

test("every status has a user-readable en.json message", () => {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), "messages/en.json"), "utf8"),
  ) as { xmtpVs: Record<string, string> };
  for (const key of [
    ...Object.values(MESSAGING_RECONNECTION_MESSAGE_KEY),
    "reconnectUncertainDismiss",
  ]) {
    const text = messages.xmtpVs[key];
    assert.equal(typeof text, "string", key);
    assert.ok(text.trim().length > 0, key);
  }
  assert.match(messages.xmtpVs.reconnectUncertainSend, /isn't sent twice/);
  assert.match(messages.xmtpVs.reconnectUnavailable, /draft is saved/);
});

// ── Send failure classification ───────────────────────────────────────────────

test("ambiguous transport failures are uncertain, not 'not sent'", () => {
  for (const error of [
    new TypeError("Failed to fetch"),
    new Error("socket hang up"),
    new Error("request timed out"),
    new Error("stream closed unexpectedly"),
    "boom",
    null,
  ]) {
    assert.equal(classifySendFailure(error), "uncertain", String(error));
  }
});

test("failures rejected before delivery are definite", () => {
  assert.equal(classifySendFailure(new Error("429 Too Many Requests")), "failed");
  assert.equal(classifySendFailure(new Error("XMTP_PEER_UNREACHABLE")), "failed");
  assert.equal(
    classifySendFailure(Object.assign(new Error("user rejected"), { code: "rejected" })),
    "failed",
  );
});

// ── Draft store ───────────────────────────────────────────────────────────────

function memoryStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const WALLET = "GB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E";
const PEER = "GCPEERPEERPEERPEERPEERPEERPEERPEERPEERPEERPEERPEERPEER";

test("drafts round-trip per wallet and peer without any XMTP inbox id", () => {
  const storage = memoryStorage();
  writeXmtpDraft(WALLET, PEER, "half-written reply", storage);
  // A remount (new component, same wallet + peer) restores it.
  assert.equal(readXmtpDraft(WALLET, PEER, storage), "half-written reply");
  // Keys are case-insensitive and carry no inbox id.
  assert.equal(readXmtpDraft(WALLET.toLowerCase(), PEER.toLowerCase(), storage), "half-written reply");
  assert.equal(xmtpDraftStorageKey(WALLET, PEER), `mimir.xmtp.draft.v1:${WALLET.toLowerCase()}:${PEER.toLowerCase()}`);
  // Other conversations and other wallets are isolated.
  assert.equal(readXmtpDraft(WALLET, "GOTHERPEER", storage), "");
  assert.equal(readXmtpDraft("GOTHERWALLET", PEER, storage), "");
});

test("blank drafts and clear remove the stored entry", () => {
  const storage = memoryStorage();
  writeXmtpDraft(WALLET, PEER, "hello", storage);
  writeXmtpDraft(WALLET, PEER, "   ", storage);
  assert.equal(storage.data.size, 0);
  writeXmtpDraft(WALLET, PEER, "hello", storage);
  clearXmtpDraft(WALLET, PEER, storage);
  assert.equal(storage.data.size, 0);
});

test("stored drafts are capped", () => {
  const storage = memoryStorage();
  writeXmtpDraft(WALLET, PEER, "x".repeat(MAX_STORED_DRAFT_LENGTH + 50), storage);
  assert.equal(readXmtpDraft(WALLET, PEER, storage).length, MAX_STORED_DRAFT_LENGTH);
});

test("missing addresses or broken storage never throw", () => {
  const throwing: DraftStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(readXmtpDraft(WALLET, PEER, throwing), "");
  assert.doesNotThrow(() => writeXmtpDraft(WALLET, PEER, "text", throwing));
  assert.doesNotThrow(() => clearXmtpDraft(WALLET, PEER, throwing));
  assert.equal(readXmtpDraft(null, PEER, memoryStorage()), "");
  assert.equal(readXmtpDraft(WALLET, undefined, memoryStorage()), "");
  assert.equal(readXmtpDraft(WALLET, PEER, null), "");
});

// ── Panel wiring ──────────────────────────────────────────────────────────────

test("the panel exposes the status line, keeps drafts and gates Send on the transport", () => {
  const panel = readFileSync(join(process.cwd(), "components/xmtp/VsXmtpPanel.tsx"), "utf8");
  assert.match(panel, /useReducer\(\s*reduceMessagingReconnection/);
  assert.match(panel, /data-reconnection-status=\{reconnectionView\.status\}/);
  assert.match(panel, /role="status"/);
  assert.match(panel, /t\(reconnectionView\.messageKey\)/);
  assert.match(panel, /readXmtpDraft\(address, peerAddress\)/);
  assert.match(panel, /writeXmtpDraft\(address, peerAddress, draft\)/);
  assert.match(panel, /classifySendFailure\(result\.error\) === "uncertain"/);
  assert.match(panel, /disabled=\{!draft\.trim\(\) \|\| !reconnectionView\.canSend\}/);
  // Drafts are keyed by wallet + peer, never by the XMTP inbox id.
  assert.doesNotMatch(panel, /XmtpDraft\([^)]*inboxId/);
});
