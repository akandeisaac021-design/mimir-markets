/**
 * #937 — deterministic message-hub failure fixtures.
 *
 * Covers the three failure families the hub must survive without ever showing
 * one account's private conversation to another:
 *
 *   A. account changes (a wallet switch while rows/content are still mounted);
 *   B. unavailable transports (each reported separately from signing support);
 *   C. expired private context (content past its lifetime, or loaded for a
 *      different account).
 *
 * `public surfaces never expose private conversation content` is checked both
 * structurally (the hub only gates the panel; it never renders message bodies)
 * and through the draft store, which is scoped per account and peer.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  getMessagesHubConnectionState,
  messagesHubVisibleThreads,
  resolveMessagesHubPrivateContext,
} from "../../lib/xmtp/messages-hub-state";
import {
  readXmtpDraft,
  writeXmtpDraft,
  type DraftStorage,
} from "../../lib/xmtp/draft-store";
import {
  HUB_ACCOUNT_A,
  HUB_ACCOUNT_B,
  HUB_ACCOUNT_CHANGE_CASES,
  HUB_NOW_MS,
  HUB_PRIVATE_CONTEXT,
  HUB_PRIVATE_CONTEXT_CASES,
  HUB_THREADS_FOR_ACCOUNT_A,
  HUB_TRANSPORT_CASES,
  PRIVATE_THREAD_BODY,
  PRIVATE_THREAD_DRAFT,
} from "../fixtures/xmtp/message-hub-failures";

test("account change: a wallet switch never shows the previous account's threads", () => {
  for (const scenario of HUB_ACCOUNT_CHANGE_CASES) {
    const visible = messagesHubVisibleThreads(
      scenario.loaded,
      scenario.currentAddress,
    );
    assert.deepEqual(
      visible.map((row) => row.id),
      scenario.expectedIds,
      scenario.name,
    );
  }

  // The same helper must also drop rows when nothing is loaded for the account.
  assert.deepEqual(
    messagesHubVisibleThreads({ address: null, items: HUB_THREADS_FOR_ACCOUNT_A }, HUB_ACCOUNT_A),
    [],
  );
});

test("unavailable transports: every state is distinct from signing support", () => {
  for (const scenario of HUB_TRANSPORT_CASES) {
    assert.deepEqual(
      getMessagesHubConnectionState(scenario.input),
      scenario.expected,
      scenario.name,
    );
  }

  // A signing outage must not be reported as a transport outage, and vice versa.
  const signingOut = getMessagesHubConnectionState({
    canSignMessages: false,
    status: "error",
    failureKind: "unsupported_wallet",
  });
  const transportOut = getMessagesHubConnectionState({
    canSignMessages: true,
    status: "error",
    failureKind: "network",
  });
  assert.equal(signingOut.transport, "not_started");
  assert.equal(transportOut.transport, "unavailable");
  assert.notDeepEqual(signingOut, transportOut);
});

test("expired private context is hidden before an account check can leak it", () => {
  for (const scenario of HUB_PRIVATE_CONTEXT_CASES) {
    assert.deepEqual(
      resolveMessagesHubPrivateContext({
        address: scenario.address,
        context: scenario.context,
        nowMs: scenario.nowMs,
      }),
      scenario.expected,
      scenario.name,
    );
  }

  // Content loaded for A is refused to B immediately, even while unexpired.
  assert.deepEqual(
    resolveMessagesHubPrivateContext({
      address: HUB_ACCOUNT_B,
      context: HUB_PRIVATE_CONTEXT,
      nowMs: HUB_NOW_MS,
    }),
    { visible: false, reason: "account_changed" },
  );
  // A context with no time limit stays visible for its own account.
  assert.deepEqual(
    resolveMessagesHubPrivateContext({
      address: HUB_ACCOUNT_A,
      context: { viewerAddress: HUB_ACCOUNT_A, expiresAt: null },
      nowMs: HUB_NOW_MS + 10 * 60_000,
    }),
    { visible: true, reason: "visible" },
  );
});

test("the hub gates the thread panel on the private-context check", () => {
  const hub = readFileSync(join(process.cwd(), "components/xmtp/MessagesHub.tsx"), "utf8");

  // The panel (the only place message bodies render) is mounted behind the gate.
  assert.match(hub, /resolveMessagesHubPrivateContext/);
  assert.match(hub, /privateContextState\.visible/);
  assert.match(hub, /messagesHubVisibleThreads/);

  // The hub itself renders claim metadata only — no decoded message bodies.
  assert.equal(hub.includes("getDecodedMessageText"), false);
  assert.equal(hub.includes("messages.map"), false);
  assert.equal(hub.includes(PRIVATE_THREAD_BODY), false);
});

test("local storage surfaces are scoped per account and peer", () => {
  const store = new Map<string, string>();
  const storage: DraftStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
  const peer = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";

  writeXmtpDraft(HUB_ACCOUNT_A, peer, PRIVATE_THREAD_DRAFT, storage);

  assert.equal(readXmtpDraft(HUB_ACCOUNT_A, peer, storage), PRIVATE_THREAD_DRAFT);
  // Account B sees no draft under its own key, and a different peer sees none either.
  assert.equal(readXmtpDraft(HUB_ACCOUNT_B, peer, storage), "");
  assert.equal(readXmtpDraft(HUB_ACCOUNT_A, HUB_ACCOUNT_B, storage), "");

  // No stored key leaks the message body outside the namespaced per-account key.
  for (const [key, value] of store) {
    assert.ok(key.startsWith("mimir.xmtp.draft.v1:"));
    assert.equal(key.includes(PRIVATE_THREAD_BODY), false);
    assert.equal(key.split(":").length, 3);
    assert.equal(value, PRIVATE_THREAD_DRAFT);
  }
});
